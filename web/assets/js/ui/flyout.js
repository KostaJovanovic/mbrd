// The toolbar's hover flyouts: what is behind a button, shown by hovering it.
//
// Every button on the bar is a single verb, and behind three of them there was
// a choice you could not see. Arrange laid the board out under whatever layout
// a <select> in the settings panel happened to be set to. Note gave you
// whichever of the four sheets a counter in import/drop.js was up to, and
// nothing anywhere could ask it for a different one. Colour opened a picker on
// grey. All three answers existed; none of them was on the bar.
//
// So: dwell on one of those three and the choices come down under it. The press
// itself is untouched - Arrange still rearranges, Note still writes one, Colour
// still opens the picker - because a flyout that swallowed the click would take
// away a one-press action to reveal a menu nobody asked for. This is a shortcut
// standing beside the button, not a gate in front of it.
//
// ── Why there is almost nothing here ──
//
// The panel is the right-click menu's, opened through openAnchored() in
// ui/menu.js. That module already measures and places, walks the rows with the
// arrow keys, and closes on outside pointerdown, wheel, scroll, resize, blur
// and Escape - which is the whole of what a flyout needs and the whole of what
// a second implementation would have got wrong differently. What is left in
// this file is the timing, the anchoring, and the three lists.
//
// ── Touch is excluded outright ──
//
// Bound only where the primary pointer hovers. Note and Colour are on the
// phone's tier, and a tap there has to add a note: `pointerover` fires on a
// touch too, so without the gate a phone would open a menu instead of doing the
// thing, and the thing would need a second tap. Arrange is data-desktop and is
// not on that tier at all.

import { openAnchored, close, setMenuCloseHook } from './menu.js';
import { el } from '../util.js';
import { ARRANGEMENTS } from '../arrange/arrangements.js';
import { NOTE_TINTS } from '../import/drop.js';
import { swatchHex } from '../canvas/renderers.js';

/**
 * How long a pointer has to rest on a button before its flyout comes down.
 *
 * The bar sits along the top of the window, which is a place a pointer crosses
 * on its way to somewhere else. Without the wait, dragging a file towards the
 * board or reaching for the browser's own chrome would rake three menus open
 * behind it. Long enough to mean it; short enough that meaning it does not feel
 * like waiting.
 */
const DWELL = 180;

/**
 * And how long the pointer has to be off both the button and the panel before
 * it goes away again.
 *
 * Longer than the dwell, deliberately. Leaving is usually an accident - the
 * pointer clips a corner on the way from the button to the row it is aiming
 * at - and a menu that vanished on that would be a menu you had to approach in
 * a straight line.
 */
const LINGER = 250;

let cmds = null;
let bar = null;
/** The button whose flyout is up, or null. */
let openFor = null;
let openTimer = 0;
let closeTimer = 0;

/**
 * data-cmd -> the rows to show. The whole of what "which buttons have one" is:
 * a button not named here is a plain button, and adding a fourth is one entry.
 *
 * The builders take `cmds` rather than closing over the module's copy, which
 * makes each of them a pure function of the command surface and so something a
 * test can call with a stub. Exported for that, and for tests/flyout.test.js to
 * check the keys against the markup.
 */
export const FLYOUTS = {
  rearrange: arrangeEntries,
  'add-note': noteEntries,
  'add-swatch': colourEntries,
};

export function initFlyouts(commands) {
  cmds = commands;
  bar = el('toolbar');
  if (!bar) return;

  // Mark the three, so a screen reader is told the button has more behind it
  // and so the stylesheet can say so as well. Written here rather than in
  // index.html because FLYOUTS is the list, and a fourth entry there should not
  // need somebody to remember the markup.
  for (const cmd of Object.keys(FLYOUTS)) {
    const btn = bar.querySelector(`[data-cmd="${cmd}"]`);
    btn?.setAttribute('aria-haspopup', 'menu');
    btn?.setAttribute('aria-expanded', 'false');
  }

  // The panel can go without this module asking - Escape, a press on the board,
  // a right-click - and the button it belongs to still owes an aria-expanded.
  setMenuCloseHook(() => {
    openFor?.setAttribute('aria-expanded', 'false');
    openFor = null;
  });

  // The keyboard route, and it is not the hover one with a different trigger.
  // Enter and Space stay the button's own press; ArrowDown is the standard way
  // into a menu hanging off a control, and it opens *with* focus so the arrows
  // that got you there keep working.
  bar.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown') return;
    const btn = e.target.closest?.('[data-cmd]');
    if (!btn || !FLYOUTS[btn.dataset.cmd]) return;
    e.preventDefault();
    open(btn, true);
  });

  if (!matchMedia('(hover: hover)').matches) return;

  // One listener on the window rather than a pair on each button, because the
  // question is not "is the pointer on this button" but "is it anywhere it
  // should keep the panel alive" - and one of those places is the panel, which
  // is a child of <body> and not of the bar. pointerover, not pointerenter:
  // enter does not bubble, and delegation is the whole point.
  addEventListener('pointerover', onOver);
  // A pointer that leaves the window entirely fires no `over` anywhere, so the
  // panel would hang until something else closed it.
  addEventListener('pointerleave', () => { if (openFor) later(); });
}

function onOver(e) {
  // A touch that reports itself as one, on a machine whose primary pointer
  // hovers - a laptop with a touchscreen. The gate above was about the device;
  // this is about the gesture, and a finger is a press either way.
  if (e.pointerType === 'touch') return;

  // Inside the open panel. Nothing to do but stay.
  if (e.target.closest?.('#ctx-menu')) { hold(); return; }

  const btn = e.target.closest?.('#toolbar [data-cmd]');
  if (btn && FLYOUTS[btn.dataset.cmd]) {
    hold();
    if (btn === openFor) return;
    // Sliding along an open bar swaps at once. This is what a menu bar has
    // always done, and the dwell would be actively wrong here: the pointer is
    // already committed to the bar, and making it stop and wait at each button
    // turns one row of menus into four separate decisions.
    open(btn, false, openFor ? 0 : DWELL);
    return;
  }

  // Anywhere else. A button on the bar with no flyout counts as elsewhere - the
  // panel under Arrange has no business staying up over Find.
  clearTimeout(openTimer);
  openTimer = 0;
  if (openFor) later();
}

/** Cancel a pending close - the pointer is somewhere that keeps the panel. */
function hold() {
  clearTimeout(closeTimer);
  closeTimer = 0;
}

/** Start the grace period. Idempotent: an already-running one is left alone. */
function later() {
  if (closeTimer) return;
  closeTimer = setTimeout(() => { closeTimer = 0; close(); }, LINGER);
}

/**
 * Bring one down.
 *
 * `delay` is 0 for the keyboard and for a swap along the bar, and DWELL for the
 * first hover. openAnchored closes whatever is up first, which fires the hook
 * above and clears openFor - so this writes the button in *after* the call, not
 * before it.
 */
function open(btn, focus, delay = 0) {
  clearTimeout(openTimer);
  if (delay) {
    openTimer = setTimeout(() => open(btn, focus), delay);
    return;
  }
  openTimer = 0;

  // The bar's outer edge, not the button's. They differ by the hairline the bar
  // wears, and that hairline would be a one-pixel strip belonging to neither
  // the button nor the panel - which is exactly the kind of gap a pointer
  // crossing between them lands in.
  const box = btn.getBoundingClientRect();
  const rect = { left: box.left, bottom: bar.getBoundingClientRect().bottom };
  const label = btn.querySelector('span')?.textContent?.trim() || 'Menu';
  openAnchored(rect, FLYOUTS[btn.dataset.cmd](cmds), { label, focus });
  openFor = btn;
  btn.setAttribute('aria-expanded', 'true');
}

// ---------------------------------------------------------------------------
// The three lists
// ---------------------------------------------------------------------------

/**
 * The layouts, and the two dials that go with them.
 *
 * One icon on all seven, the way stickerTintEntries() puts one i-swatch on all
 * eight tints: these are a radio, the tick is the state, and seven different
 * drawings for seven arrangements would be seven pictures nobody could read at
 * 15px. The list itself is arrange/arrangements.js's, in its order, so the
 * flyout and the panel's <select> cannot come to hold different sets.
 *
 * Desktop's catalogue and not Mobile's, and that needs no test: Arrange is
 * data-desktop, so the button this hangs off does not exist on the tier where
 * MOBILE_ARRANGEMENTS applies.
 */
export function arrangeEntries(cmds) {
  const now = cmds.arrangement();
  return [
    ...ARRANGEMENTS.map(a => ({
      label: a.label,
      icon: 'i-rearrange',
      check: now === a.id,
      action: () => cmds.arrangeAs(a.id),
    })),
    { sep: true },
    // Hidden rather than greyed when nothing is selected, which is this menu's
    // idiom throughout (see the item fold's `hidden: !tintable`). A row that
    // cannot do anything is a row explaining a rule; a row that is not there is
    // a menu that fits what you are holding.
    { label: 'Rearrange selection', icon: 'i-select-all',
      hidden: !cmds.hasSelection(), action: () => cmds.rearrangeSelection() },
    // The gap the layouts pack at. Live, and it does not lay the board out on
    // its own - Desktop's spacing is a rule the next Rearrange uses, which is
    // what the panel's own hint says - so moving it and then picking a layout
    // is the order this is meant to be used in.
    { label: 'Spacing',
      range: {
        min: 0, max: 200, step: 4, unit: 'px',
        get: () => cmds.getSetting('spacing') ?? 0,
        set: v => cmds.setSetting('spacing', v),
      } },
  ];
}

/**
 * The pad, as four sheets you can take one off.
 *
 * Named for the pigment each is mixed from rather than for the colour it comes
 * out as, and that is the same decision tokens.css made one layer down: a note
 * is `color-mix(--accent-warm 34%, --paper-card)`, so on a board that has taken
 * its palette from its photographs the first sheet is not yellow and calling it
 * Yellow would be this menu describing a board that is not on the screen. The
 * chip beside each row is the actual colour, drawn from the same token, so the
 * naming carries none of the weight.
 */
export function noteEntries(cmds) {
  const NAMES = ['Warm', 'Accent', 'Green', 'Pale'];
  return Array.from({ length: NOTE_TINTS }, (_, i) => ({
    label: NAMES[i] || `Sheet ${i + 1}`,
    swatch: `var(--note-${i + 1})`,
    action: () => cmds.addNote(i + 1),
  }));
}

/**
 * The board's own pigments, as swatch cards - and the picker, still.
 *
 * The same five the connection palette offers (connectionColorEntries in
 * ui/menu.js) and the same words for them, because they are the same five
 * colours and a board should not have two vocabularies for its own paint. What
 * makes this worth having over the picker is that these follow the board: on
 * one that has coloured itself from its pictures, these are that board's
 * colours, and dropping one next to the pictures it came from is a swatch that
 * means something.
 */
const PIGMENTS = [
  ['--accent', 'Accent'],
  ['--accent-warm', 'Warm'],
  ['--accent-deep', 'Deep'],
  ['--leafy', 'Green'],
  ['--ink', 'Ink'],
];

export function colourEntries(cmds) {
  return [
    ...PIGMENTS.map(([token, label]) => ({
      label,
      swatch: `var(${token})`,
      action: () => cmds.addSwatchOf(tokenHex(token)),
    })),
    { sep: true },
    { label: 'Pick a colour...', icon: 'i-swatch', action: () => cmds.addSwatch() },
  ];
}

/**
 * A custom property, as the `#rrggbb` a swatch card stores.
 *
 * Through a probe element rather than getPropertyValue, and that is the whole
 * reason this function exists: reading the property back gives its *specified*
 * text, so a token written as `color-mix(in srgb, ...)` - which several of
 * these are, on several of the themes - comes out as that string and is not a
 * colour anything can store. Painting it and reading `color` makes the engine
 * do the resolving, which is the same trick boardInk() uses in canvas/model.js.
 *
 * swatchHex() has the last word, so anything that still fails to resolve lands
 * on SWATCH_DEFAULT rather than writing nonsense into a board file.
 */
function tokenHex(token) {
  const probe = document.createElement('span');
  probe.style.cssText = 'position:fixed;left:-9999px;width:0;height:0';
  probe.style.color = `var(${token})`;
  document.body.append(probe);
  const rgb = getComputedStyle(probe).color;
  probe.remove();
  const m = rgb.match(/(\d+(?:\.\d+)?)/g);
  if (!m || m.length < 3) return swatchHex(rgb);
  const hex = m.slice(0, 3)
    .map(n => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, '0'))
    .join('');
  return swatchHex('#' + hex);
}
