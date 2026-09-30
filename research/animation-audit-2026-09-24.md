# The motion audit — 24 September 2026

**Status: partly done, 2026-09-24.** All twenty built (commits 17dbdac,
dcc3400, bf5f7d1) except two halves that want a browser first: the delete
ghost's size away from 100% zoom (14) and `#viewport`'s `bottom` transition
(15), neither touched. 15's Playlist kept its padding - a translate cannot
narrow the column - and only lost the overshoot. 11 needed no new token: the
glyph press is `max(0.85, 1 - (1 - --btn-press) * 6.33)`, which is 1 at Harsh.
Nothing here has been felt by a person yet; the checks under each fix are
still owed.

Twenty fixes, written so each can be done on its own by someone who has not
read the rest.

Every animation, transition, WAAPI call and rAF loop under `web/assets` was
read against one set of rules (Emil Kowalski's): animate only with a purpose
and never on keyboard or very frequent actions; exits and entrances ease out
and on-screen movement eases in and out; UI stays under 300ms, menus and
popovers 150–250ms, modals and drawers 200–500ms; nothing grows from
`scale(0)`; things that are re-triggered quickly must be interruptible;
transform and opacity only; reduced motion means less movement, not no
feedback. Line numbers are at commit `1b01727`. Where a fix says "**(P)**",
the code makes the case but it wants confirming in a browser first.

## What is already right, and what was left alone

Right, and not to be touched: the pan glide (exponential decay off the clock),
pinch and wheel (instant, every path calls `stopAnim()`), the Mobile edge
settle (critically damped, carries velocity), menus growing from their trigger
or cursor with a 0.97 floor and no `scale(0)`, `flushLeaving()` keeping one
`#ctx-menu` on a quick re-open, the Playlist's drag-to-reorder, and the grid's
tier crossfade. No `transition: all` anywhere.

Left alone because a comment argues for it: panels sliding in on `--ease-back`
(`tokens.css:489`, "so panels settle like they have weight"); the trash fall
on `--ease-in`; `--dur-palette` at 700ms; `+`/`-` animating and fit/home taking
400ms (`viewport.ts:426-429`); the canvas at 0s under the Quality dial; clean
mode's own curve; the toast's literal 300ms; the fold's reversed `--ease-in`.

## Order

Do 1 before 6 (both edit the `zoomMs`/`travelMs` block in `viewport.ts`).
Everything else is independent. By value for effort: **1, 2, 3, 7, 12, 4, 8,
5, 6, 9, 10**, then the rest.

Every fix is checked the same way mechanically, and that is not repeated below:
`npm test`, `npm run typecheck`, `npm run lint` (from PowerShell — the Bash
wrapper mangles its output) and `npm run build` all pass. The feel checks need
`npm run dev` running. DevTools' Animations panel at 10% speed is the tool for
most of them; Rendering → "Emulate prefers-reduced-motion" for the rest.

---

## 1. JS-driven motion ignores prefers-reduced-motion — HIGH

**Problem.** Reduced motion is honoured for CSS by one rule
(`status.css:186-199`: all durations cut to 0.01ms). It cannot reach a WAAPI
`.animate()` with an explicit duration or a rAF loop, and two big motions are
exactly that:

- The document viewer's four sheet flights check only `travelMs() > 0`
  (`viewer.ts:341, 382, 420, 493`): the page sliding up the whole window with a
  2° turn, dropping off it on close, and the card flying between a sticky and
  its page. `travelMs()` never asks about reduced motion:
  ```ts
  // viewport.ts:430-443
  export const zoomMs = () => cssMs('--dur-zoom', 190);
  export const travelMs = () => cssMs('--dur-travel', 400);
  ...
  const reducedMotion = () =>
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  ```
  The comments at `viewer.ts:414`, `viewer.ts:481` and `tour.ts:194` say it
  is handled. It is not. A CSS rule setting `--dur-travel: 0` would not do
  either: a board's look may set that token inline (`look.ts:13`).
- Clean mode's star wipe, spider and drips read only the Quality dial:
  `playIntro(..., quality.anim, showMess)` (`clean/clean.ts:756`), and
  `quality.anim` again at `clean.ts:1056, 2417, 2504, 3034, 3064, 3122`.
  `playIntro` already has a still path when `motion` is false.

**Change.**
1. `viewport.ts`: move `reducedMotion` above `zoomMs`, export it, and gate
   both durations:
   ```ts
   /** The OS asking for less motion. The CSS flatten (status.css) cannot reach
    *  a duration read here, so the reading itself answers 0. */
   export const reducedMotion = () =>
     typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
   export const zoomMs = () => (reducedMotion() ? 0 : cssMs('--dur-zoom', 190));
   export const travelMs = () => (reducedMotion() ? 0 : cssMs('--dur-travel', 400));
   ```
   Every caller already treats 0 as "don't animate": the viewer falls back to
   its opacity fade, `_animate` snaps, the note composer closes at once.
2. `clean.ts`: import `reducedMotion` from `../../canvas/viewport.ts`, add
   `const moving = () => quality.anim && !reducedMotion();` with a one-line
   comment, and replace every `quality.anim` read with `moving()`
   (`grep "quality\.anim"` in that file must come back empty; leave
   `quality.grain` alone).
3. Make the comments true: `clean/intro.ts:110` gains "or the OS asking for
   reduced motion"; `tour.ts:194` becomes
   `// travelMs() answers 0 under prefers-reduced-motion, so the flight is a cut.`

**Check.** With reduced motion emulated: a document fades in with no slide
and closes at once on Escape; a sticky turned into a document and back swaps
with no flight; F and 0 cut; clean mode's black fades rather than a star
opening, and no spider walks. With it off, all of it is as before.

## 2. The Ctrl+K search palette animates — HIGH

**Problem.** `#search` (`menu.css:12-25`) carries
`animation: ctx-in var(--dur-fast) var(--ease);` — fade, 3px drop, 0.97 scale
— on every Ctrl+K (`search.ts:50`). A palette opened from the keyboard many
times a day should be there on the next frame; its close is already instant
(`search.ts:122`).

**Change.** Delete that line and leave in its place:
```css
  /* No entrance. A palette opened from the keyboard is read the moment it is
     asked for; the close is instant too (ui/search.ts). */
```
and amend the header (`menu.css:3-4`) to "card paper, hairline, shadow; the
four pointer-opened ones also share the ctx-in entrance."

**Check.** Ctrl+K repeatedly: the palette is simply there; the Animations
panel records nothing.

## 3. Menus replay their pop-in where nothing moved — MEDIUM

**Problem.** `render()` (`menu.ts:1020`) always builds a fresh `#ctx-menu`,
and `menu.css:127` always gives it `ctx-in`. So it pops in when:
- opened from the keyboard — ArrowDown on a flyout button (`flyout.ts:72`),
  the ContextMenu key / Shift+F10, Enter on a fold;
- a drill-down page turns — `swap()` removes the old page outright because
  "a page turn must not flinch" (`menu.ts:997`), then renders the new one with
  the pop-in anyway;
- the pointer hops from one open toolbar flyout to the next — the dwell is
  skipped (`flyout.ts:98-99`) but the entrance is not.

**Change.**
1. `MenuOpts` (`menu.ts:68`): add `instant?: boolean;` with the doc
   `/** no entrance or exit - see .is-instant in menu.css */`.
2. Near `let down` (`menu.ts:343`):
   `/** The last input was a key, not a pointer. */ let byKeys = false;` — and in
   `initMenu()`, after the `pointerdown` that records `down` (line 304):
   ```ts
   addEventListener('keydown', () => { byKeys = true; }, true);
   addEventListener('pointerdown', () => { byKeys = false; }, true);
   addEventListener('pointermove', () => { byKeys = false; }, true);
   ```
3. `render()`, after `node.id = 'ctx-menu';`:
   `if (opts.instant || byKeys) node.classList.add('is-instant');`
4. `swap()` (`menu.ts:999`): add `instant: true` to the options it passes.
5. `dismiss()` (`menu.ts:220`), first line:
   `if (el.classList.contains('is-instant')) { el.remove(); return; }` — or the
   panel sits inert on screen for `LEAVE_MS` waiting for an `animationend`
   that never comes.
6. `openAnchored()` (`menu.ts:481-489`): accept `instant = false` in its
   destructured options and pass it to `render`.
7. `flyout.ts`: `open()` (line 133) takes a fourth parameter `instant = false`
   and passes it to `openAnchored`; line 99 becomes
   `open(btn, false, openFor ? 0 : DWELL, !!openFor);`.
8. `menu.css`, after `@keyframes ctx-in-side` (line 138):
   ```css
   /* Opened from the keyboard, turned to as a drill-down page, or swapped in for
      a flyout already open: nothing spatial to explain, so no entrance.
      ui/menu.ts removes these at once on close as well. */
   :is(#ctx-menu, #ctx-child).is-instant { animation: none; }
   ```

**Check.** A right-click with the mouse pops in as before. The ContextMenu
key, ArrowDown on Arrange, Enter on a fold and "Back" all show the menu with
no animation, and Escape removes it at once. Hover Arrange until it opens,
slide to Note and Colour: only the first pops in.

## 4. The connection chip re-pops on every press — MEDIUM

**Problem.** The chip over a marked line carries two cycling buttons, and
"pressing the thing you are looking at to see the next state is the whole
reason a chip beats a menu" (`conn-chip.ts:121-124`). But each press changes
the signature, and a changed signature rebuilds the chip:
```ts
// conn-chip.ts:99-100
const next = `${conn.a}\0${conn.b}\0${dir}\0${style}\0${meta.label || ''}`;
if (next !== sig) { build(conn, dir, style, !!meta.label); sig = next; }
```
`build()` removes the node and makes a new one, which plays `ctx-in`
(`menu.css:316`) — the chip blinks and pops on every press, and the pressed
button is destroyed, so keyboard focus drops to `<body>`. Hiding it off-screen
with `node.hidden` (`conn-chip.ts:191`) restarts the animation too, so panning
the line back into view pops it again.

**Change.**
1. Rename `sig` to `pair` (the two card ids only) and add module refs
   `dirBtn`, `styleBtn`, `labelBtn` (`HTMLButtonElement | null`).
2. `syncConnChip()`: rebuild only when `pair` changes, then always
   `paint(meta.dir || 'none', meta.style || 'solid', !!meta.label)`.
   `closeConnChip()` resets `pair` and the three refs.
3. `build(conn)` makes the buttons with placeholder icons; the two cycle
   buttons read the current state *when pressed*, since the chip now outlives
   a change:
   ```ts
   const now = () => cmds!.connectionStyle(conn.a, conn.b) || {};
   dirBtn = button(DIR_ICON.none, DIR_TITLE.none, () => set({ dir: nextIn(DIRS, now().dir || 'none') }));
   styleBtn = button(STYLE_ICON.solid, STYLE_TITLE.solid, () => set({ style: nextIn(STYLES, now().style || 'solid') }));
   labelBtn = button('i-style', 'Add a label', () => cmds!.editConnectionLabel(conn.a, conn.b));
   ```
4. Add:
   ```ts
   /** Show the line's current settings on the chip, without rebuilding it. */
   function paint(dir: ConnDir, style: ConnStyle, labelled: boolean): void {
     relabel(dirBtn, DIR_ICON[dir], DIR_TITLE[dir]);
     relabel(styleBtn, STYLE_ICON[style], STYLE_TITLE[style]);
     relabel(labelBtn, 'i-style', labelled ? 'Change label' : 'Add a label');
   }
   function relabel(b: HTMLButtonElement | null, name: string, title: string): void {
     if (!b || b.dataset.icon === name && b.title === title) return;
     b.dataset.icon = name;
     b.title = title;
     b.setAttribute('aria-label', title);
     b.replaceChildren(icon(name));
   }
   ```
5. `place()`: `node.style.visibility = off ? 'hidden' : '';` instead of
   `node.hidden = off`, with a sentence on why (display:none restarts the entrance).
6. The file header: "rebuilt only when a different line is marked; its
   settings repaint in place."

**Check.** Mark a line: the chip pops in once. Click the arrow button five
times fast: the icon walks through its four states with no blink. Tab to it
and press Space repeatedly: focus stays. Pan the line away and back: no pop.
Mark another line: one pop.

## 5. Submenus close while being aimed at — MEDIUM

**Problem.** A fold's submenu opens beside its row, top-aligned
(`menu.ts:1199-1200`). Reaching its lower rows means moving diagonally across
the sibling rows below the fold, and each one closes the child on contact:
```ts
// menu.ts:1119-1121
btn.addEventListener('pointerenter', e => {
  if (e.pointerType === 'mouse' && childFrom === panel) closeChild();
});
```
The 220ms grace (`CHILD_GRACE_MS`) only covers being over neither panel. So
the submenu flickers out and in as it is aimed at.

**Change.** The aim triangle, as macOS does it.
1. Beside `let childTimer` (`menu.ts:1148`):
   `/** Where the pointer left the open child's row. */ let leftAt: { x: number, y: number } | null = null;`
   and clear it in `closeChild()`.
2. After `fadeChild()`:
   ```ts
   function onRowLeave(e: PointerEvent) {
     leftAt = { x: e.clientX, y: e.clientY };
     fadeChild();
   }
   /** Whether a point is on the way from where the pointer left the row to the
    *  near edge of the child. Crossing a sibling there is aiming, not leaving. */
   function aimingAtChild(x: number, y: number): boolean {
     if (!child || !leftAt) return false;
     const c = child.getBoundingClientRect();
     const nearX = c.left >= leftAt.x ? c.left : c.right;
     const a = leftAt, b = { x: nearX, y: c.top - 8 }, d = { x: nearX, y: c.bottom + 8 };
     const side = (p: { x: number, y: number }, q: { x: number, y: number }) =>
       (q.x - p.x) * (y - p.y) - (q.y - p.y) * (x - p.x);
     const s1 = side(a, b), s2 = side(b, d), s3 = side(d, a);
     return !((s1 < 0 || s2 < 0 || s3 < 0) && (s1 > 0 || s2 > 0 || s3 > 0));
   }
   ```
3. `menu.ts:1212`: `row.addEventListener('pointerleave', onRowLeave);` (a named
   handler, so a re-open does not stack listeners).
4. The sibling handler becomes: return unless mouse and `childFrom === panel`;
   `if (aimingAtChild(e.clientX, e.clientY)) return;` (the row's grace then
   decides); otherwise `closeChild()`.

**Check.** Hover a fold with a long submenu, then move diagonally to its
bottom row across two or three siblings: it stays open. Move straight down
instead: it closes at once. Stop on a sibling: it closes after the grace.
Near the right edge (submenu flipped left) the same holds leftwards.

## 6. The document viewer opens and closes too slowly — MEDIUM

**Problem.** Closing a document, Escape included (`viewer.ts:214-218`):
```ts
// viewer.ts:385-393
const long = ms * 1.1;
const opts = { duration: long, easing: 'cubic-bezier(0.55, 0, 0.8, 0.2)', fill: 'forwards' as const };
...
dlg.animate([...], { ...opts, easing: 'ease-in' }),
... part.animate([{ opacity: 1 }, { opacity: 0 }], { ...opts, duration: long * 0.6, easing: 'ease-in' })),
```
A strong ease-in over 440ms (770ms at Softish), during which the dialog takes
no input (`pointerEvents = 'none'`). The page barely moves for the first
~130ms, and the desk and ribbon fade on `ease-in` too, so the board stays
hidden longest exactly when the user has asked for it back. Opening is
`ms * 1.6` (`viewer.ts:345`): 640ms, 1120ms at Softish. And the fallback fade
is a literal `{ duration: 180, easing: 'ease-out' }` (`viewer.ts:341, 419`),
which still plays with Quality's animations off.

**Change.**
1. `viewport.ts`, beside `travelMs` (after fix 1):
   `export const fastMs = () => cssMs('--dur-fast', 130);` — no reduced-motion
   zero here: a fade is what reduced motion keeps.
2. `viewer.ts`: import `fastMs`; both `duration: 180` become `duration: fastMs()`.
3. `viewer.ts:345`: `ms * 1.6` → `ms * 1.1`.
4. `viewer.ts:385-393`: `const long = ms * 0.7;`, the sheet's easing becomes
   `cssEase()` (the app's `--ease`, already read by the grow), and the desk
   and parts fade on `'ease-out'`. Keep the transforms (down the window,
   tipping 1.5°) — the direction is the design, only its curve changes. The
   doc comment gains: "Off the mark at once and quick - the user asked to be
   back on the board, so the first frames are the ones that must move."

This reverses a deliberate "gathers speed as it falls". If the maintainer
wants the fall kept, the fallback is: the old curve on the *sheet only*, at
`ms * 0.7`, with the desk and parts on `ease-out`.

**Check.** Open a document: settled in under half a second. Escape: moving on
the first frame, board visible almost at once, gone in ~0.3s. Try Softish and
Harsh. With Quality's animations off, a document appears at once.

## 7. Rapid zoom steps lose ground — MEDIUM

**Problem.** `+`/`-` (`input.ts:3279-3280`) and the pill's buttons
(`hud.ts:58-59`) each start a 190ms step from `z0 = this.zoom`
(`viewport.ts:987`), and `_animate` cancels the previous one. With key repeat
(~30ms) each 1.25× step gets ~40% of the way before being replaced, so a held
key zooms by roughly 1.09× a repeat and how far it gets depends on the OS
repeat rate.

**Change.** Remember where a running step is heading and build on that.
1. Class field (after `_anim`, `viewport.ts:491`):
   `_zoomTo: number | null;           // where a running zoom step is heading - see zoomAnimAt()`
   and `this._zoomTo = null;` in the constructor beside `this._anim = null;`.
2. `stopAnim()`: first line `this._zoomTo = null;` (before its early return).
3. `zoomAnimAt()`:
   ```ts
   const z0 = this.zoom;
   // A step pressed while one is still flying builds on where that one was
   // going, so a held key zooms the same whatever the repeat rate.
   const from = this._anim != null && this._zoomTo != null ? this._zoomTo : z0;
   const z1 = clamp(from * factor, MIN_ZOOM, MAX_ZOOM);
   ...
   this._animate(ms, e => {
     ... (unchanged)
     if (e === 1) this._zoomTo = null;
   });
   // After _animate, whose stopAnim() clears it; and only if a flight is running.
   this._zoomTo = this._anim != null ? z1 : null;
   ```

**Check.** At 100%, four fast `+` presses land on 244% exactly. One press
alone is unchanged. Grabbing the board mid-flight stops it where it is.

## 8. A finger on a card lifts it — MEDIUM

**Problem.** Card hover is mirrored from pointer events so the shadow twin
can lift too (`items.ts:343-350`), and `pointerover` fires for a finger at
touch-down. So on a phone a press lifts the card and its pinned stickies on
the overshoot curve (6px and 1.03× at Softish), holds it up through a pan that
starts on it, and bobs it back on release.

**Change.** `items.ts:347`:
```ts
world.addEventListener('pointerover', e => {
  // A finger's pointerover is the press itself, not a hover - see flyout.ts's
  // per-event touch rule. Lifting on it read as the card jumping under the finger.
  if (e.pointerType === 'touch') return;
  setHoverGroup(itemIdFromEvent(e.target));
});
```
Pen stays as it is; a pen really hovers.

**Check.** In device emulation with touch (or a phone), at Softish: pressing
and panning from a card leaves it flat; `.is-hover` never appears. With a
mouse, unchanged.

## 9. Fly-to swings the destination outward first — MEDIUM (P)

**Problem.** Fit, home, zoom-to-item (search, inventory), the pill's reset and
tour stops all go through `viewTo()`, which moves zoom geometrically and the
pan linearly in board units:
```ts
// viewport.ts:1036-1041
this._animate(ms, e => {
  this.zoom = e === 1 ? z1 : z0 * Math.pow(z1 / z0, e);
  this.pan.x = this.isMobile ? 0 : x0 + (x1 - x0) * e;
  this.pan.y = y0 + (y1 - y0) * e;
  this.apply();
});
```
With screen position `(w - pan) * zoom` (`toScreen`, `viewport.ts:806`), on a
10× zoom-in the target first moves *away* from the centre (about 160% of its
starting distance a quarter of the way in) and then rushes in. The eye loses
the thing it is being taken to.

**Change.** Zoom about the one point that is at the same place on screen at
the start and the end. It solves `(f - p0) z0 = (f - p1) z1`, so
`f = (p1 z1 - p0 z0) / (z1 - z0)` and `p(e) = f - (f - p0) z0 / z(e)`, the same
formula for x and y. Every point then travels in a straight line on screen.
```ts
// Zoom and pan together as one zoom about the point that stays put on screen
// from start to end. A linear pan under a geometric zoom swung the
// destination out from the centre before bringing it in.
const pivot = !this.isMobile && Math.abs(Math.log(z1 / z0)) > 1e-3;
const fx = pivot ? (x1 * z1 - x0 * z0) / (z1 - z0) : 0;
const fy = pivot ? (y1 * z1 - y0 * z0) / (z1 - z0) : 0;
this._animate(ms, e => {
  this.zoom = e === 1 ? z1 : z0 * Math.pow(z1 / z0, e);
  if (e === 1) { this.pan.x = this.isMobile ? 0 : x1; this.pan.y = y1; }
  else if (pivot) {
    this.pan.x = fx - (fx - x0) * z0 / this.zoom;
    this.pan.y = fy - (fy - y0) * z0 / this.zoom;
  } else {
    this.pan.x = this.isMobile ? 0 : x0 + (x1 - x0) * e;
    this.pan.y = y0 + (y1 - y0) * e;
  }
  this.apply();
});
```
Easing and durations stay. Mobile keeps the linear path.

**Check.** Watch slowly (set `--dur-travel: 4000ms` on `:root` in DevTools;
do not commit it). Zoomed out to ~15%, Ctrl+K to a card near the edge: it
travels steadily inward as it grows. F from zoomed-in: everything shrinks
toward one point. The end views are identical to before.

## 10. A hand-picked pigment skips the palette fade — MEDIUM (P)

**Problem.** A palette change fades the colour tokens on `:root` over 700ms,
and `followFade()` (`appearance.ts:266-289`) is what makes that look right:
`.is-fading` holds every other transition still so buttons do not chase the
sheet and flash (`tokens.css:566-589`), `onChange()` repaints the canvas's
cached colours every frame, and `settle()` re-reads the controls at the end.
`setPigments`, `dropPigments` and `apply` all call it. `setVar()` does not
(`appearance.ts:541-607`), and picking an accent in the Pigment picker
(`appearance-controls.ts:125-136`) rewrites the whole sheet through it. So
the `:root` transition runs with no `.is-fading` — the flash — and
`persist()` repaints the canvas once at t≈0, in the old colours, and never
again: the grid and the lines look stale until something else redraws them.

**Change.** In `setVar()`, `if (pigment) followFade();` at the end of the
`value === ''` branch (after `syncPaletteMode()`) and at the very end after
`persist({ soon: true })`, with a comment: "A pigment moves the whole sheet,
so it fades as a palette change does." Also fix two stale comments: setVar
does not run "on every frame of a colour drag" (the picker is a dialog that
returns one value) — it runs on every input of a *slider*
(`appearance.ts:566-567`, `appearance-controls.ts:130-131`).

**Check.** In Firefox, where the flash is worst: pick a very different
accent. Before: buttons lag and flash, and the grid keeps the old colour until
you pan. After: one surface turning over ~0.7s, grid included. Dragging the
radius slider starts no fade.

## 11. Undo and redo press on the slow curve; Harsh presses at all — LOW

**Problem.** The zoom pill and toolbar override their glyph press to be fast
and flat, and argue it: "Press: fast, no overshoot — feedback, not decoration"
(`chrome.css:68-74`, `chrome.css:228-232`). The history pill has the same
buttons and no override, so undo and redo press in over `--dur-base` on the
overshoot curve:
```css
/* drawer.css:160-166 */
#history-ctl svg { ... transition: transform var(--dur-base) var(--ease-back); }
#history-ctl button:hover:not(:disabled) svg { transform: scale(var(--btn-grow)) translateY(var(--btn-lift)); }
#history-ctl button:active:not(:disabled) svg { transform: scale(calc(var(--btn-press) - 0.08)); }
```
And `- 0.08` is a constant, so Harsh — which sets `--btn-press: 1` under
"Nothing moves on its own" (`tokens.css:1080-1087`) — still presses these
glyphs to 0.92.

**Change.**
1. `drawer.css:166` becomes the same shape as `chrome.css:228-232`:
   ```css
   #history-ctl button:active:not(:disabled) svg {
     transform: scale(calc(var(--btn-press) - 0.08));
     /* The press curve, argued at #zoom-ctl's copy of this line (chrome.css). */
     transition: transform var(--dur-fast) var(--ease);
   }
   ```
2. Harsh: add `--glyph-press: 1;` to the Harsh block after `--btn-press: 1;`
   (`tokens.css:1087`), `--glyph-press: calc(var(--btn-press) - 0.08);` to the
   `:root` block after `--btn-press: 0.985;` (`tokens.css:98`), and replace
   the three `scale(calc(var(--btn-press) - 0.08))` (`chrome.css:69, 229`,
   `drawer.css:166`) with `scale(var(--glyph-press))`. A new token needs
   entries in `look.ts`'s `TOKENS` and `layout-settings.ts`'s `AXIS_TOKENS`
   only if boards may set it — they should not, so leave both lists alone
   and check `tests/appearance.test.js` still passes (it holds those lists
   against tokens.css; if it objects, add the token to both lists instead).
3. `#drawer-btn:hover svg` (`drawer.css:57`) and `#history-ctl`'s hover
   (`drawer.css:165`) are not inside `@media (hover: hover)` as the zoom and
   toolbar copies are; wrap them the same way.

**Check.** Undo/redo presses feel the same as zoom +/-. At Harsh, no toolbar,
zoom or history glyph moves on press. On a touch screen, tapping the drawer
button does not leave its icon lifted.

## 12. Every sheet is removed by its fallback timer — LOW

**Problem.** `hideSheet()` waits for the slide to end:
```ts
// sheet.ts:31-33
el.addEventListener('transitionend',
  e => { if (e.propertyName === 'transform') done(); }, { once: true });
exits.set(el, setTimeout(done, EXIT_MS));
```
`{ once: true }` removes the listener after the *first* `transitionend`,
whatever it was — and the sheets' opacity transition (`--dur-fast`) ends
before their transform (`--dur-base`), see `drawer.css:193-195`. So the
transform check never passes and every sheet (drawer, sticker pad, Playlist)
is removed by the 500ms timer, invisible on screen for the difference.
Reopening the drawer during that gap builds a second `#drawer-window`.

**Change.**
```ts
const onEnd = (e: TransitionEvent) => {
  // Its own slide, not the fade that ends first or a child's bubbling up.
  if (e.target !== el || e.propertyName !== 'transform') return;
  el.removeEventListener('transitionend', onEnd);
  done();
};
el.addEventListener('transitionend', onEnd);
```
`done()` should also remove the listener if the timer wins; give `done` access
to `onEnd` by declaring `onEnd` before it.

**Check.** Close the drawer and watch the Elements panel: `#drawer-window`
goes the moment its slide ends (~240ms), not at 500ms. Close and reopen fast:
never two `#drawer-window`s.

## 13. The drag pickup is dead CSS — LOW

**Problem.** `items.css:71-76` and `canvas.css:119` style `.item.is-dragging`
and `.item-shadow.is-dragging` — at Softish, a card picked up rises 16px and
leans −2° (`tokens.css:971-972`). No JS ever adds that class to a board item
(only `playlist.ts` and `timeline-view.ts` use the name, for their own rows),
and the history shows canvas JS never did. At the default tier the tokens are
0, so only Softish loses anything.

**Change.** Either wire it or delete it; the maintainer decides. To wire:
where a card drag starts in `canvas/input.ts` (the branch that adds
`#viewport.is-moving`, line 2491), add `is-dragging` to each dragged item's
node and its shadow twin, and remove it on drop and on cancel. To delete:
remove the two rules and the `:not(.is-dragging)` in `items.css:82`.

**Check (if wired).** At Softish, a picked-up card lifts and leans under the
pointer, and settles on drop. At the default tier nothing changes.

## 14. A deleted card's ghost overlaps its undo — LOW (P)

**Problem.** A delete clones the card into `#exit-layer` above everything and
plays a keyframe exit (`exit-anim.ts:53-76`, `items.ts:871-874`). Nothing can
cancel the clone, so Ctrl+Z inside 240ms (400ms at Softish) brings the card
back under its own ghost still falling. Separately, the clone is sized to the
card's on-screen box (`exit-anim.ts:66-71`) while its contents are in board
pixels, so away from 100% zoom the first frame may not match the card that
was there.

**Change.**
1. `exit-anim.ts`: export
   ```ts
   /** Take back an exit still playing: its card has come back. */
   export function cancelExit(id: string): void {
     for (const g of document.querySelectorAll<HTMLElement>('#exit-layer .exit-anim')) {
       if (g.dataset.id === id) g.remove();
     }
   }
   ```
   (the clone keeps the card's `data-id`, set in `item-dom.ts:459, 540`).
2. `items.ts`, `reconcile()`: when `delta.added` is present, call
   `cancelExit(id)` for each. Check first that an undo of a delete does emit
   `added`; if it emits no delta, cancel for every id in the live board that
   has a clone.
3. The zoom mismatch: confirm it in the browser at 30% and 300% first. If it
   is real, size the clone at the card's layout size (`el.offsetWidth`,
   `el.offsetHeight`), centre it on the on-screen box, and scale it by the
   current zoom with the individual `scale` property, which composes with the
   keyframes' `transform`.

**Check.** Delete a card and press Ctrl+Z at once: no ghost over the returned
card. At 30% zoom, the exit starts from exactly the card that was there.

## 15. Two layout-property transitions — LOW

**Problem.** `#viewport` transitions `bottom` (`canvas.css:21`) when the
Timeline fades on idle, tours and clean mode. Each frame resizes the board
box, which runs the viewport's `ResizeObserver` (measure and apply) — layout
work on the most sensitive surface, every time the chrome wakes from idle.
And `#mobile-playlist` transitions `padding-left` on the overshoot curve
(`mobile.css:47`), re-laying out the whole column each frame on tablets.

**Change.** For the Playlist: move the column with `translate` instead —
transition `translate var(--dur-base) var(--ease)` (no overshoot on a column
of text) and set the offset as `translate: <the same calc> 0` on the open
state; keep the padding for the settled layout only if the centring needs it
(check at 700px and 1200px wide). For `#viewport`: this one is argued
(`canvas.css:19-28`); measure first with the Performance panel while the idle
fade runs. If the frames are over budget, drop the transition and let the
bar's fade cover the change, as the comment already does for the other
direction.

**Check.** On a tablet width, opening the sidebar slides the Playlist column
without overshoot, and the Performance panel shows no layout per frame.

## 16. Small cleanups — LOW

Each is one or two lines.

- **Busy strip.** Its hide timer is a literal 260ms (`overlays.ts:126`)
  against a `var(--dur-base)` transition (`status.css:57-58`) that is 400ms at
  Softish, so the strip is cut mid-exit there; and the exit inherits
  `--ease-back`, so it overshoots on the way out — the opposite of what
  `chrome.css:470-477` argues for `#nowplaying`. Hide on the strip's own
  `transitionend` for `translate` (timer as backstop), and give the leaving
  state `transition: translate var(--dur-fast) var(--ease), opacity var(--dur-fast) var(--ease);`
  with `.is-up` keeping the current entrance.
- **Fence offer origin.** `fence-prompt.ts:105-111` places the offer 12px off
  the cursor, flipped at edges, but never sets `transformOrigin`, so its
  `ctx-in` (`menu.css:298`) grows from its centre. Set
  `node.style.transformOrigin` to the cursor's corner, as `placeRoot` does
  (`menu.ts:1256-1258`): `${x > clientX ? 0 : 100}% ${y > clientY ? 0 : 100}%`.
- **Entrance offset after a flip.** `ctx-in`'s −3px and `ctx-in-side`'s
  −4px (`menu.css:137-138`) always come from above / the left, so a menu
  flipped above its button, or a submenu flipped left, arrives moving toward
  its trigger. Add `.is-up` / `.is-left` classes where the flips happen
  (`menu.ts:1244-1245`, `menu.ts:1196-1198`) and mirror the offsets for them.
- **Hover gates.** `.pn-back:hover` (`patch.css:77-81`) and `.pv-back:hover`
  (`privacy.css:80-85`) move on hover outside `@media (hover: hover)`, unlike
  the plates in the same files. Wrap them.
- **Shatter.** `exit-shatter` ends at `scale(0)` with a 1.06 pop first
  (`drawer.css:468-472`) and is Harsh's delete. End at `scale(0.9)` and drop
  the 20% pop: Harsh is the tier where nothing bounces.
- **Connection-line fades.** `FADE_IN_MS = 400`, `FADE_OUT_MS = 300`
  (`web.ts:75-76`) sit off the whimsy axis that `viewport.ts:419-424` argues
  for. Read `--dur-base` (in, 240ms at the default) and `--dur-fast` (out)
  instead, with the same `cssMs` reading `viewport.ts` uses.
- **A fold pressed mid-motion snaps.** `openAndShut` cancels the running
  animation and starts a full 0↔full one (`panel.ts:279-284`, same in
  `paintReveal` at `panel.ts:399-404`), so the box jumps before it moves. Call
  `running.reverse()` on the running animation instead of cancelling it and
  starting a new one, and have the `finished` handler read the current
  `target` rather than the `opening` it closed over. Check both the fold and
  a reveal run.

**Check.** Each by eye at 10% speed in the Animations panel.

## 17. Missed: a photo opens from nowhere — additive

Opening a picture from a Feed tile (`feed.ts:695`) or a board card pops the
viewer from the centre (`ask-in`). A lightbox is anchored to the thumbnail it
came from, and the code already has the move: `openViewer(id, { from })`
(`viewer.ts:64, 266`) makes `growFrom` fly a card from a rectangle, but only
stickies pass `from`. Pass the tile's or the card's `getBoundingClientRect()`
from those two call sites, and teach `growFrom` (or a sibling of it) to grow
the picture itself rather than a blank paper card. Reduced motion is already
covered by fix 1.

## 18. Missed: rearranging teleports every card — additive

`board-actions.ts:779-786` commits the new positions and then flies the view
to fit, so every card jumps. Slide the cards that are on screen from where
they were to where they land: `translate` from the old offset to none,
`cubic-bezier(0.77, 0, 0.175, 1)` (the in-and-out curve on-screen movement
wants), `--dur-travel`, 30–80ms stagger, capped like `EXIT_ANIM_CAP` and
limited to what is on screen, the way `.is-reshape-seen` limits the corner
change (`tokens.css:625-644`). The stagger must never delay input: the
positions are committed before anything plays.

## 19. Missed: the toast stack jumps — additive

`#toast` is a bottom-anchored column (`status.css:139-151`); each new line
(`overlays.ts:34`) pushes the others up by its height in one frame, and the
fifth line is dropped with no fade (`overlays.ts:35`). Before appending,
record each line's `top`; after, animate each from its old offset
(`translate: 0 Δpx` → `0 0`, `--dur-fast`, `--ease`). Fade the dropped line
the way an expiring one fades (`is-going`) instead of removing it.

## 20. Missed: the Timeline strip jumps the foot — additive

Opening or closing the strip (`timeline-view.ts:249-265`) toggles `hidden`
and writes `--dock`, so everything anchored to the foot (the drawer dock, the
now-playing bar, the panels' bottoms, the toast host) jumps by the strip's
height in one frame, while the board box eases (`canvas.css:21`). Slide the
strip in and out with `translate: 0 100%` → `0 0` on `--dur-base`, `--ease`,
and write `--dock` at the start of an open and the end of a close. This
touches the two ordering rules in `index.html` (`--foot-left` /
`--foot-right`, `chrome.css`), so check the three states they guard: a
phone, the Timeline open, and something playing.
