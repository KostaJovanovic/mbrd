# The motion audit, 5 October 2026

**Status: open, 2026-10-05.** Nothing here is built. Read-only audit of the
source at `b44b923` plus the uncommitted selection-ring work in the tree
(`#item-rings`, `.item-ring` in `canvas.css`, `paintRing()` in
`canvas/items.ts`). Line numbers are the working tree's on that date.

Second in the series after `animation-audit-2026-09-24.md`. That one judged
the motion against Emil Kowalski's rules; this one judges it against Apple's
fluid-interface principles. Those are response on touch-down, 1:1 direct
manipulation, interruptibility from the live value, springs and velocity
handoff, spatial consistency (things leave the way they came), rubber-banding,
compositor-only hot paths, sound on the motion's frame, and reduced motion
meaning *gentler* rather than *none*. Where something the 09-24 audit listed
is still wrong, it says "still open from 09-24".

**Covered:** every CSS transition, animation, keyframe and reduced-motion
rule under `web/assets/css`. Every `.animate()` and every rAF loop that moves
something under `web/assets/js`. The viewport flights, glide, settle and
pinch. The card drag, resize, hover and pickup. The new selection ring. The
viewer (photo and document). The note composer. The exit animations. The
rearrange slide. The sheets, menus, toasts, Timeline strip and sidebar. The
drawer and sticker-pad drag-outs. The cuelume scheduling. The desktop
title-bar panel.

**Skipped:** `web/lab*.html` and clean mode (`ui/clean/`), apart from one
reduced-motion note (finding 15).

**How sure.** Everything below was read from code and none of it was
watched. Findings marked **(P)** rest on inference about rendering. Confirm
those in a browser first, using DevTools' Animations panel at 10%, or
Rendering → "Emulate prefers-reduced-motion".

Every fix gets the usual mechanical check, which is not repeated below:
`npm test`, `npm run typecheck`, `npm run lint` (run from PowerShell) and
`npm run build`.

---

## Must fix: reads as broken

### 1. The new selection ring falls out of step with its card

**Files.** `canvas.css` (`.item-ring`, uncommitted), `items.css:65-85`,
`items.ts:76-79` (`setHoverLift`), `items.ts:2085-2117` (`paintRing`),
`dialog.css:388` (`note-land`), `notes.ts:1153-1156` (`openComposer`).

**What happens now.** The ring is a twin in another layer. It copies the
card's `is-` classes only when `paintRing()` runs, and it styles only
`.is-dragging`. Three moments break the "same box, same lift" promise in its
header:

- **Clicking an unselected card with a mouse (every tier).** The card was
  hover-lifted: `--lift-hover` −3.6px and `--grow-hover` 1.018, or −6px and
  1.03 at Softish. The press selects it, and
  `.item.is-selected:not(.is-dragging).is-hover` drops it back over
  `--dur-base` on `--ease-back`, overshoot included. The ring appears
  instantly at the resting box. For about 240ms (400ms at Softish) the card
  visibly settles *through* its own outline. On a 300px card the grow alone
  is about 2.7px a side at the default tier. Before this change the ring was
  the card's own `::before`, so it rode the card's transform.
- **A note landing from the composer.** `.item.is-landing` plays `note-land`
  on the card (`translateY(-10px) scale(1.06)` → rest). The ring has no
  matching rule (its class is `item-ring`, not `.item`), so it stands still
  while the card drops into it.
- **Opening the composer** moves the card node out of `#world`
  (`mount.append(node)`). Nothing there calls `paintRing()`, so a selected
  note leaves its ring outlining an empty hole under the dimmed backdrop. It
  stays there until some `geom`, `item` or `selection` event repaints. This
  is inferred: an edit may emit an event that clears it, and that has not
  been confirmed.

**Principle.** Direct manipulation and spatial consistency. A selection
outline that lags or leads its object reads as two objects.

**Fix.**
1. In `canvas.css`, give `.item-ring` the hover state the card has, so it
   follows the same transition the card is running:
   ```css
   .item-ring.is-hover { --lift: calc(var(--lift-hover) / var(--iz)); --grow: var(--grow-hover); }
   .item-ring.is-selected:not(.is-dragging).is-hover { --lift: 0px; --grow: 1; }
   ```
   `paintRing()` already copies `is-hover` and `is-selected`. Then call
   `paintRing(gid)` for each changed id inside `setHoverGroup()`, after
   `setHoverLift`. The hover class then lands on the ring the same frame it
   lands on the card, and the click's drop transitions both together.
   - The ring's `scale`/`translate` transition must be the card's
     (`--dur-base`, `--ease-back`). It already is.
2. Add `.item-ring.is-landing { animation: note-land var(--dur-base) var(--ease-back); }`
   next to `.item.is-landing`, and call `refreshRings()` right after
   `node.classList.add('is-landing')` in `notes.ts`. Do the same wherever
   else a card gets a one-shot keyframe class.
3. In `openComposer()`, call `refreshRings()` (already exported) after
   `mount.append(node)` and after the node goes home in `onDone`.
   `canvas/notes.ts` already imports from `./items.ts`'s neighbourhood; check
   the import does not create a cycle. If it would, have `items.ts` export a
   `ringFor(id)` hook and wire it the way `setNoteMenu()` is.

**Cost and risk.** `setHoverGroup` runs on every `pointerover`. `paintRing`
writes nothing when nothing changed, so this costs a few attribute reads per
hover change. No layering change.

**Check.** At Softish, hover an unselected card, then press it: the card and
the ring settle together. Write a note and press Save: the ring drops in with
the card. Double-click a selected note: no ring is left on the board behind
the dim.

### 2. A Timeline slide pressed mid-flight jumps, and the slide relayouts the board every frame

**Files.** `timeline-view.ts:287-303` (`slideDock`), `canvas.css:6, 21`.

**What happens now.** `slideDock()` cancels the running animations
(`for (const a of sliding) a.cancel()`). It then starts a fresh one from the
far end: an open always starts at `--dock: 0px` and `translate: 0 100%`, a
close at full height. Press the Timeline toggle twice quickly. The strip and
everything standing on `--dock` snap to an end, then slide. This is exactly
the cancel-and-restart that fix 16 removed from the folds.

Separately, `--dock` is animated on `:root`. It is an inherited registered
property, so every element in the document restyles on every frame for
`--dur-base`. `#viewport`'s `inset: 0 0 var(--dock) 0` also resizes the
board box each frame, which runs the viewport's `ResizeObserver` (measure and
apply). The `bottom` transition at `canvas.css:21` does the same on every
idle fade. That transition is **still open from 09-24 #15**, which asked for
a measurement first; none was recorded.

**Principle.** Interruptibility: a re-target must start from the live value.
Also hot paths: layout and style per frame on the most sensitive surface.

**Fix.**
1. Interrupt: if `sliding` is non-empty and its animations are still
   `running`, call `a.reverse()` on each and return `true`. Do not cancel and
   restart. The existing `finished.then` on the strip already re-checks
   `open`. Add the same guard for the open case:
   `if (opening) s.hidden = false` before reversing.
2. Performance (P), measure first. In the Performance panel, on a phone-sized
   board with ~200 cards mounted, toggle the strip. If frames run over 16ms:
   - stop animating `--dock` on `:root`;
   - animate only the strip's `translate`;
   - write `--dock` once, at the start of an open and at the end of a close,
     which is what 09-24 #20 originally proposed. The strip is opaque and
     covers the band while it moves.
   - If the furniture riding up and down is wanted, animate `translate` on
     those few fixed elements (drawer dock, `#nowplaying`, `#toast`) rather
     than an inherited property.
3. `canvas.css:21`: apply the same measurement. If it is over budget, drop
   the transition, as the comment at `canvas.css:26-28` already does for the
   other direction.

**Cost and risk.** The `index.html` foot ordering rules (`--foot-left` /
`--foot-right`). Check a phone, the Timeline open, and something playing.

### 3. The photo viewer is not direct manipulation

**Files.** `viewer.ts:289-302` (swipe), `viewer.ts:665-671` (close),
`viewer.ts:797-930` (`attachZoomPan`).

**What happens now.** This is the place a phone user most expects iOS-Photos
physics.

- **A sideways swipe** is read only at `pointerup`. The picture does not move
  under the finger. On lift past 60px, `step()` tears down and mounts the
  next picture as a cut, with no slide.
- **Click or tap to zoom** (`ZOOM_CLICK` 2.5×) and click-to-fit (`reset()`)
  are instant jumps. That is the very cut `viewport.ts:445-447` argues
  against for the board.
- **Pan is hard-clamped** (`clampPan`). Pinch-out below 1× stops dead at 1.
  There is no rubber band and no momentum on release.
- **Closing a photo** is `dlg.close()`, a one-frame cut. Fix 17 made it
  *open* by growing out of its thumbnail, so it now arrives along one path
  and vanishes on none.

**Principle.** Direct manipulation (2), interruptibility (3), momentum (6),
spatial consistency (7), rubber-banding (9).

**Fix**, in order of value:
1. **Close back into the thumbnail.**
   - Keep the `from` rect `openViewer()` was given (`open.thumb`), in a
     module `let shownFrom: DOMRect | null`.
   - In `closeViewer()`, for a `data-media` viewing with `shownFrom` and
     `travelMs() > 0`, play `growPicture`'s keyframes reversed. That is the
     picture from `none` to `translate(dx,dy) scale(s)`, on `cssEase()`,
     over `travelMs() * 0.6`, with the backdrop colour and `#viewer-head`
     fading out alongside.
   - `dlg.close()` goes in `finished`, the way `leave()` does. Do not set
     `pointerEvents: none`: a press during the close should
     `finishClose()` instead.
   - Re-measure the card's rect at close time, via
     `cmds.cardRect?.(id)` or the Feed tile. The board may have moved.
   - If the card is off screen, fade instead.
2. **Animate click-zoom and fit.** In `zoomTo` and `reset` when called from
   a click, set `img.style.transition = 'transform ' + travelMs()*0.5 + 'ms ' + cssEase()`
   for that one paint, then clear it on `transitionend`. Wheel, pinch and
   drag stay instant, as the board does.
3. **Swipe follows the finger.**
   - In the viewer's `pointermove` (touch, not zoomed, not editing), write
     `img.style.translate = dx + 'px 0'`.
   - On lift past `SWIPE_MIN`, or a flick faster than ~500px/s, animate the
     current picture out to ±100vw. Mount the next picture coming in from
     the other side, on `--ease`, over `--dur-base`.
   - Otherwise animate back to 0 on the same curve. The current
     `pointerup`-only path becomes the fallback.
4. **Edges and momentum for a zoomed pan** (polish). Past `maxX`, apply the
   `give()` curve from `viewport.ts:212-214` (export it), and settle back on
   release. Hand the release speed to an exponential glide as
   `Viewport.glide()` does.

**Cost and risk.** None to the invariants. `step()` already tears down
properly, so a slide only needs the old `<img>` kept for one animation.
Reduced motion: `travelMs()` answers 0, so every one of these becomes
today's cut.

---

## Should fix: noticeably un-fluid

### 4. A long-press on a card gives no feedback until the menu appears

**Files.** `input.ts:2428-2448`, `items.ts:423-429`.

**What happens now.** On a touch screen the hover lift is off (09-24 #8,
correctly), and a press on an unpicked card is a `tapGate`, which selects
only on lift. A finger held on a card therefore shows nothing at all for
`LONG_PRESS_MS` (480ms). Then the menu pops in. The user cannot tell a hold
that is working from one that has missed.

**Principle.** Response: something must change at touch-down, and a hold
should show its progress.

**Fix.**
- On a touch `pointerdown` that arms `hold.timer`, add `.is-pressing` to the
  card node and its shadow twin (and the ring, if selected) after 120ms of
  stillness, via a `setTimeout` cleared by the same paths that clear
  `hold.timer`.
- In `items.css`:
  `.item.is-pressing { --grow: 0.975; transition: scale calc(480ms - 120ms) var(--ease); }`,
  plus the same on `.item-shadow`. A slow shrink that completes as the menu
  opens.
- Remove the class when the menu opens, on lift, and on pan. Removing it on
  a menu open lets the card spring back on `--ease-back`, which is the
  "pop" the menu answers with.
- Optionally `navigator.vibrate?.(8)` at the open on Android.
- At Harsh (`--btn-press: 1`) make it `--grow: 1`, so nothing moves.

**Cost.** One class on one card. Phone-safe, since only `scale` changes.

### 5. Undo, redo, align, distribute and a cancelled drag teleport cards

**Files.** `commands.ts:135-165`, `input.ts:3125-3141` (abort path), the
undo/redo commands. Compare `board-actions.ts:554, 835, 937, 961`, which do
slide.

**What happens now.** Rearrange and Nudge board slide their cards
(`seenPlaces` → commit → `slideFrom`). Undo of either does not: the Undo
button on their own toast puts forty cards back in one frame. Align,
Distribute and Same width/height jump. A drag interrupted by a second finger
or the context menu `applyGeom(gesture.before)`s the card straight back
under the finger, with no motion.

**Principle.** Spatial consistency: a change and its reverse should travel
the same path, and an object should not teleport.

**Fix.**
- In `commands.ts`, wrap `alignIds`, `matchSizeIds`, `distributeIds` and the
  `undo`/`redo` command entries:
  - `const seen = seenPlaces(ids)` before;
  - `slideFrom(seen, travelMs())` after.
  - For undo/redo, the ids are the last command's touched ids if history
    exposes them. Otherwise take every mounted id; `seenPlaces` already
    keeps only on-screen cards and caps at 80.
  - `history.ts` must not import `canvas/`. Do it in the command layer,
    which already imports `travelMs` (layering rule).
- In `input.ts`'s abort branch, collect `seenPlaces(ids)` before
  `applyGeom(gesture.before)` and slide after, at `baseMs()`. The put-back is
  short.
- Not for a Timeline replay, whose stepping already animates the view
  (`timeline-view.ts:349`).

**Cost.** `slideFrom` animates `transform` only, so it is compositor work.
It touches the card, the twin and the ring. Size changes still jump, which
is acceptable.

### 6. New cards appear in one frame; deleted ones animate out

**Files.** `items.ts` `reconcile()` (`delta.added`), `exit-anim.ts`.

**What happens now.** A delete plays a tiered exit (dissolve, fall or
shatter). Undo of that delete, paste, duplicate, a drop from the drawer or
the sticker pad, and an import all *appear* with no entrance. The exit has no
mirror. A pasted card at the pointer is easy to miss.

**Principle.** Spatial consistency, entering along the path the exit used.
Also response.

**Fix.**
- In `reconcile()`, when `delta.added` is present and this is not a board
  load (no-delta loads never reach here), animate each added and mounted
  node, its twin and its ring:
  `[{ opacity: 0, scale: '0.94' }, { opacity: 1, scale: '1' }]` over
  `fastMs()`, `cssEase`.
- Use the `scale` *property* in the keyframes, not `transform`, so the
  device snap and `item.rot` in `transform` are untouched. The card's own
  `scale: var(--grow)` is overridden only for the duration.
- Cap at `EXIT_ANIM_CAP` and on-screen only.
- Skip entirely when `quality.anim` is off.
- For an undo of a delete specifically, `cancelExit(id)` already runs. The
  entrance then reads as the ghost reversing.

**Cost.** Up to 12 short compositor animations, on a commit and never per
frame.

### 7. The note composer opens from the middle of the window, not from the note

**Files.** `notes.ts:1130-1298`, `dialog.css:301-312, 388`.

**What happens now.** Double-clicking a note lifts the live card out of the
board, leaving a hole. The card reappears magnified up to 2.25× in a dialog
that plays `ask-in` from the window's centre. Closing puts it back and plays
`note-land`. The code already knows how to fly a card between a sticky and a
sheet (`viewer.ts` `growFrom` / `shrinkInto`, through `NoteEntrance`), but
only the document conversions use it.

**Principle.** Spatial consistency: an editor should grow out of the thing
being edited and shrink back into it.

**Fix.**
- In `openComposer()`, read `node.getBoundingClientRect()` *before*
  `mount.append(node)`. After `showModal()` and `fit()`, cancel the dialog's
  `ask-in` (`for (const a of dlg.getAnimations()) a.cancel()`, as the
  `into` path does).
- FLIP the mount from the old rect:
  `translate(dx,dy) scale(s)` → `none`, over `travelMs() * 0.6`, on
  `cssEase()`, with `transform-origin: 0 0`.
- Fade the toolbar and buttons in behind it, the way `showComposer()` does.
- On a plain Save/Cancel, run the reverse to the card's board rect before
  `close()`. `note-land` then becomes unnecessary; keep it only for when the
  card is off screen.
- Reduced motion and Quality-off fall to `travelMs() === 0`, which is
  today's behaviour.

**Cost.** One transform animation on the mount. The mount's whimsy-0
`rotate(-1.6deg)` is on `transform`. Animate the individual `translate` and
`scale` properties instead so the two compose.

### 8. Under reduced motion every fade goes too

**Files.** `status.css:194-201`.

**What happens now.** The universal rule cuts every `animation-duration` and
`transition-duration` to 0.01ms. Menus, dialogs, toasts, sheets, the sidebar,
the busy strip and `#nowplaying` therefore all pop on and off. Apple's (and
WCAG's) reading of reduced motion is: replace movement with a cross-fade,
not with a cut. The JS side already gets this right: `fastMs()` is
deliberately not zeroed (`viewport.ts:456-458`), so the viewer fades. The
CSS side contradicts it. Smaller cases: `chrome.css:393, 832, 1106` set
`transition: none` outright on `#nowplaying`, `#tour` and `#tour-editor`.

**Principle.** 14: a gentle equivalent, not no feedback.

**Fix.** Keep the duration flatten for `transform`-bearing animations, but
let opacity live. Inside the `@media (prefers-reduced-motion: reduce)` block:

1. Neutralise movement at the token level:
   `:root { --lift-hover: 0px; --lift-drag: 0px; --tilt-drag: 0deg; --grow-hover: 1; --btn-lift: 0px; --btn-grow: 1; --ease-back: var(--ease); }`.
2. Redefine the entrance keyframes as fades. Keyframes declared later inside
   the media block win: `ctx-in`, `ctx-in-side`, `ctx-in-up`,
   `ctx-in-left`, `ask-in`, `rise`, `bloom`, `note-land`,
   `toolbar-relaid`. For example
   `@keyframes ask-in { from { opacity: 0; } }`, and the `ctx-out*`
   variants as `to { opacity: 0 }`.
3. Change the universal rule to flatten only non-opacity transitions. CSS
   cannot select by property, so instead:
   - drop `transition-duration` from the `*` rule;
   - keep `animation-iteration-count: 1`;
   - flatten `animation-duration` only for the infinite loops by name, as
     `quality.css:248-262` already does;
   - for the sliding panels (`#sidebar`, `#header-panel`, `.sheet`,
     `#busy`, `#tour`), set the closed-state `transform`/`translate` to
     `none` under reduced motion, so only their opacity transitions.
   - Keep `#viewport, #viewport * { transition-duration: 0s }` untouched.
4. Replace the three `transition: none` blocks with `transform: none` on the
   hidden state.

**Cost and risk.** This is a broad CSS change. Walk every overlay with the
emulation on. `sheet.ts` waits for a `transform` `transitionend` with a
500ms timer backstop, so a sheet with no transform transition is removed by
the timer, invisibly. Better: have `hideSheet` also accept
`propertyName === 'opacity'`.

### 9. A mouse-wheel notch zoom is a 17% cut

**Files.** `input.ts:3264`, `viewport.ts:936-948`, `input.ts:405-415`.

**What happens now.** Each notch arrives as `zoomAt(..., factor)`:
`Math.exp(0.0016 × 100)` ≈ 1.17×, applied in one frame. The `+`/`−` keys and
the pill's buttons glide over `--dur-zoom` precisely because "a discrete
1.3x cut gives you no idea which way the board went" (`viewport.ts:445`). A
notch is the same discrete step from a different device. Pinch and trackpad
streams are continuous and rightly instant.

**Principle.** Response and continuity.

**Fix.**
- When `readWheel()` latched the burst as a *wheel*, not a pinch
  (`e.ctrlKey && !ctrlDown` is false), call
  `vp.zoomAnimAt(e.clientX, e.clientY, w.factor, Math.round(zoomMs() * 0.6))`.
  Do not call `zoomAt`.
- `zoomAnimAt` already accumulates through `_zoomTo` (09-24 #7), so fast
  notches compound correctly. Every pointer path already calls `stopAnim()`.
- Keep `w.undo`'s pan instant.
- This reverses the "direct manipulation stays instantaneous" sentence at
  `viewport.ts:971-975` for one device. Amend that comment, or leave the
  finding for the maintainer to decline.

**Cost.** One rAF loop per notch burst, which is the code path `+` already
uses. `zoomMs()` is 0 under reduced motion and Quality-off.

### 10. The drawer and sticker-pad drag ghosts vanish on drop and on cancel

**Files.** `drawer.ts:798-828, 887-897`, `sticker-window.ts:376-394, 411-414`,
`drawer.css:434-441`, `sticker-pad.css:163-172`.

**What happens now.**
- The ghost centres on the pointer (`translate: -50% -50%`, or a −32px
  margin), so it jumps to put its middle under the finger at lift. The grab
  offset is lost.
- It is moved by `left`/`top` on every move.
- On drop over the board it is removed in one frame and the real card
  appears at board size.
- On a cancel (dropped over the window) it simply disappears, instead of
  going back to the slot it came from.

**Principle.** Direct manipulation (grab offset), and spatial consistency
(cancel returns home).

**Fix.**
- Record `offset = pointer − slot rect centre` at lift and keep it.
- Move the ghost with `style.translate` (compositor) and drop `left`/`top`.
- On cancel, animate the ghost's `translate` back to the slot's current rect
  centre over `fastMs()` on `--ease`, then remove it.
- On drop, animate the landed card in from the ghost's rect: one FLIP on the
  new node, `scale` from ghost width ÷ card width, `fastMs()`. That can be
  finding 6's entrance with a `from` rect.

**Cost.** Small. Two modules.

### 11. The pickup's shadow does not lean with the card

**Files.** `canvas.css:105, 124-125` versus `items.css:33, 71-76`.

**What happens now.** 09-24 #13 wired the drag pickup (`setDragging`). The
card's `rotate` includes `var(--tilt)`, which is `--tilt-drag` (−2° at
Softish), and so does the new ring's. The shadow twin's
`rotate: calc(var(--item-tilt, 0) * var(--tilt-max))` does not. Under
`data-snap` and `data-no-tilt` it is forced to `0deg`. At Softish a
picked-up card therefore leans while its shadow stays square, and the
shadow's corners show past the card. At the default tier `--tilt-drag` is 0,
so nothing shows. **Regressed in effect:** the rule was harmless while the
pickup was dead CSS.

**Principle.** Direct manipulation: the object and its shadow are one thing.

**Fix.** In `canvas.css`:
- `.item-shadow { rotate: calc(var(--item-tilt, 0) * var(--tilt-max) + var(--sh-tilt, 0deg)); }`
- `.item-shadow.is-dragging { --sh-tilt: var(--tilt-drag); }`
- `:root[data-snap] .item-shadow { rotate: var(--sh-tilt, 0deg); }`, with
  the same for `data-no-tilt`. That mirrors `items.css:50-53`, which keep the
  drag lean.

**Check.** At Softish, drag a card. The shadow leans with it and settles back
on drop.

---

## Polish

### 12. One gesture, three timings: opening the sidebar

`sidebar.ts:253-258` pans the board over `travelMs()` (400ms, the viewport's
cubic ease-out). The panel slides over `--dur-base` (240ms) on `--ease-back`,
with overshoot (`sidebar.css:135`). The toolbar's `left` moves over
`--dur-base` on `--ease` (`chrome.css:133`). The board keeps drifting for
160ms after the panel has landed and bounced.

**Fix.** `panFor()` passes `baseMs()` instead of `travelMs()`. Consider
`--ease` for the panel too, since overshoot without momentum breaks
principle 4. That last part reverses the argued "panels settle like they
have weight" at `tokens.css:489`, so it is the maintainer's call.

### 13. No rubber band at the zoom limits

`viewport.ts:936-948` clamps to `MIN_ZOOM`/`MAX_ZOOM`. A pinch at 500% stops
dead while the fingers keep spreading, which reads as the gesture having
failed. The Mobile board's pan already has the right tool (`give()`,
`_settleMobile`).

**Fix.**
- Track the pinch's raw zoom in the `pinch` gesture.
- Past a limit, show `limit × exp(give(log(raw/limit), log(2)))`.
- On lift, animate back to the limit about the pinch midpoint over
  `zoomMs()`.
- Desktop only, and not the wheel.

### 14. The exit ghost's first frame can differ from the card (P)

**Still open from 09-24 #14, part 2.** `exit-anim.ts:78-83` sizes the clone
to `getBoundingClientRect()`, which is the screen box: rotated bounding box,
lift and zoom all folded in. The contents stay in board pixels, so a note
deleted at 30% zoom may reflow larger on the first frame.

There is also a new observation. The `exit-*` keyframes animate `transform`,
which replaces the clone's inline `transform`. That inline value holds
`item.rot` and the device snap, so a card with its own rotation turns upright
as it leaves, and `exit-shatter`'s explicit `0% { transform: scale(1) }`
does it on frame one.

**Fix.**
- Size the clone with `el.offsetWidth`/`offsetHeight`, centred on the rect.
- Add `style.scale = vp.zoom` as an individual property.
- Move the keyframes to the individual `translate`/`rotate`/`scale`
  properties, so the inline `transform` (rot and snap) composes underneath.

### 15. Clean mode still flies under reduced motion

`clean.ts:1360, 1419` (tool flights), `3774` (`tossNode`, a 300° spinning
toss), `4412` (the Spotless card's fall, which also animates `filter`) and
`2938` play regardless of `moving()`. Wrap each in `if (moving())`, with the
existing end state applied directly otherwise.

### 16. Desktop title-bar panel: first visible frame (P)

`desktop/chrome/panel.ts:58-64` starts `panel-drop` (130ms) while the window
is hidden. `main.ts:874-889` shows the window only after a second IPC round
trip and `setBounds`. On a slow show, most of the drop may have played
unseen. Measure it: if the panel appears already settled, start the
animation from a `panel:shown` message instead. The reduced-motion fade there
is right.

---

## Already good: leave it alone

- **Pan and glide.** Glide is clock-integrated exponential decay, handed the
  finger's velocity over a 90ms window, with an idle-before-lift veto, and
  any touch interrupts it (`viewport.ts:882-917`, `input.ts:1620-1653`).
- **The Mobile edge.** A finger past it gets a diminishing rubber band. The
  settle is critically damped, carries the throw's velocity in, and never
  overshoots (`viewport.ts:199-226, 704-792`). This is the best piece of
  motion in the app.
- **View flights.** Zoom steps accumulate (`_zoomTo`). Fly-to zooms about the
  fixed point, so nothing swings out. Every flight starts from the live view
  and is cancelled by any input.
- **The card drag.** Tracks 1:1 with the grab offset (`input.ts:2594-2667`).
  Pickup (`setDragging`) and drop are interruptible CSS transitions. Edge-pan
  ramps up rather than lurching (`edge-pan.ts`).
- **Sound.** `pick` on pointer-down and `tap` per card on drop fire in the
  same tick as their visual change. The 12ms spacing is below a frame and the
  80ms cap never becomes a queue (`cuelume/engine.ts:203-237`).
- **Folds and reveals.** They reverse from where they are (`panel.ts:303,
  424`). Sheets end on their own `transform` (`sheet.ts`).
- **Menus.** They grow from the trigger or cursor, mirror direction when
  flipped, skip the entrance from the keyboard, and keep one `#ctx-menu`.
  Ctrl+K is instant.
- **Rearrange and Nudge board** slide on screen only, capped and staggered,
  with nothing waiting on them (`items.ts:89-130`).
- **Reduced motion in JS.** `travelMs`/`zoomMs` answer 0, `fastMs` keeps
  fades, glide and settle snap. The infinite loops are cut to one lap in both
  the media query and the Quality dial.
- **The document viewer's rise, drop and sticky flights**, as fixed on 09-24.
  Toast restacking from measured offsets.
- Left alone because a comment argues for it, as on 09-24: the toolbar's
  width morph, the fold's `height` animation, `#mobile-playlist`'s padding,
  the 700ms palette fade, and the Light-quality `0s` on the canvas.

---

## Second pass (narrow)

**Scope.** Read in full: menus and flyouts (`ui/menu.ts`, `ui/flyout.ts`, `menu.css`), Find and the connection chip, the Playlist's reorder, the Feed, `#nowplaying`, the tour bar and tour editor, and the text editor's ribbon, find bar, outline, Vomit Mode and counts.
Same rules, same tree, same caveat: read from code, nothing watched. Findings continue the numbering above; **(P)** marks inference about rendering.

### Must fix: reads as broken

#### 17. A stop's peek fades the cards and leaves their shadows and rings at full strength

**Files.** `canvas/items.ts:580-584` (`setSpot`), `item-chrome.css:547`,
`canvas.css:110-113, 156-159`, `ui/tour-edit.ts:118-124` (`peekStop`).

**What happens now.** In the tour editor, a pointer on a chip or a card's
number puts `:root.is-stop-peek` on and every card outside the stop drops to
`opacity: 0.25`. `setSpot()` writes `is-spot` only on the card nodes (`nodes`),
and the rule names only `.item`. The shadow twins (`#item-shadows`) and the
selection rings (`#item-rings`) are other layers and keep full opacity. So the
board's "faded" cards are 25% pictures standing on 100% shadows: grey slabs
where cards were. Pressing a chip selects its cards, so the next chip hovered
also leaves those cards' rings at full strength round faded cards. The tag
filter and `board-lifted` already handle this by naming `.item-shadow` too
(`items.css:697-709`); this rule was missed.

**Principle.** One object, one state: the card and its shadow fade together.

**Fix.**
- `setSpot()`: toggle `is-spot` on `shadows.get(id)` and the ring (if
  mounted) in the same loop as the card.
- `item-chrome.css:547` becomes
  `:root.is-stop-peek :is(.item, .item-shadow, .item-ring):not(.is-spot) { opacity: 0.25; }`.
  Both twins already transition `opacity` over `--dur-base`, so they fade in
  step with the card.

**Cost.** One class on two more nodes per card, on a hover change only.
Check at the default tier with shadows on: hover a chip, and the faded cards
are faint all the way down.

#### 18. The Playlist's equalizer keeps dancing after the music stops

**Files.** `ui/playlist.ts:260-263, 434-438` (`markPlaying`),
`playlist.ts:307-320` (`refreshActions`), `mobile.css:1035-1051`.

**What happens now.** A row is `.is-playing` while its track is the queue's
current one, and `.pl-row.is-playing .pl-eq` shows four bars bouncing on an
infinite `pl-eq` loop. Pause does not clear the now-playing record
(`canvas/audio.ts` only sets it on `play`), and `markPlaying()` runs only on
`onNowPlaying`, which pause and `ended` never fire (the module says so at
`playlist.ts:293`). So the equalizer keeps bouncing over a silent track,
paused or finished. The hero disc beside it gets this right:
`refreshActions()` toggles `.is-spinning` off `!el.paused`.

**Principle.** Motion has to tell the truth. A level meter moving with no
sound is the interface saying the opposite of what is happening.

**Fix.**
- In `refreshActions()`, which already runs on `play`, `pause` and `ended`,
  also toggle `is-paused` on the playing row in both views:
  `for (const v of [mobileView, windowView]) v?.listEl.querySelector('.pl-row.is-playing')?.classList.toggle('is-paused', !playing);`.
- `mobile.css`: `.pl-row.is-paused .pl-eq i { animation-play-state: paused; }`.
  That freezes the bars where they are, which is the honest reading of "paused".
  Or settle them to `scaleY(0.25)` on a `--dur-fast` transition.

**Cost.** None. The loop stops, so it saves work too.

### Should fix: noticeably un-fluid

#### 19. The Feed jumps whenever the wall reflows

**Files.** `ui/feed.ts:1620-1646` (`layout`), `feed.ts:1716-1720`
(`placeTile`), `feed.ts:627-637` (`learnRatio`, `relayoutIfReshaped`),
`feed.ts:1799-1805` (`dropTile`), `mobile.css:139-148`.

**What happens now.** Every tile is placed with an inline `transform`, and
`.feed-tile` has no transition. `layout()` runs on every `items` and `geom`
event and whenever a picture loads at a different shape than guessed. It then
repositions every mounted tile in one frame. You see it in three places:
- deleting a tile: it vanishes and everything below it teleports up into the
  gap. The canvas plays an exit for the same delete;
- a paste, a duplicate or an undo: the wall shifts in one frame;
- scrolling into tiles whose pictures load at their real shape: the columns
  below re-pack under the thumb, one jump per picture that guessed wrong.

**Principle.** Spatial continuity. Things that move should be seen moving,
and the reader should not lose their place.

**Fix.**
- In `layout()`, before the slots are rebuilt, copy each mounted tile's old
  box: `const was = new Map([...tiles.keys()].map(id => [id, slotById.get(id)?.box]))`.
- After `cullWindow(true)`, for each mounted tile whose box moved by more
  than 1px, play
  `t.el.animate([{ translate: \`${dx}px ${dy}px\` }, { translate: '0 0' }], { duration: baseMs(), easing: readToken('--ease') })`.
  This uses the individual `translate` property, so it composes with the
  inline `transform` placement and stays on the compositor. A size change
  still jumps, which is acceptable at this scale.
- Skip the animation when `cols` or the grid width changed, because that
  layout came from a window resize, which must stay instant. Skip it too when
  `baseMs()` is 0 or `reducedMotion()` holds.
- For a delete, have `dropTile` give an on-screen tile a short exit instead of
  `remove()`: `opacity 1 → 0, scale 1 → 0.96` over `fastMs()`, then remove.
  Do that only for drops caused by an `items` delta, not for drops caused by
  culling.

**Cost.** One WAAPI animation per mounted tile that moved (about a screenful,
at most a few dozen), on a commit and never per scroll frame. The `items` bus
fires often, so the moved-by-1px check must stay first.

#### 20. Opening the editor's outline or find bar shoves the page in one frame

**Files.** `ui/editor/view.ts:1137-1143` (`toggleOutline`),
`view.ts:1395-1420` (`openFind`, `closeFind`), `editor.css:324-340, 405-407`.

**What happens now.**
- **Outline.** It appears in one frame as a 250px panel down the left, and
  `.has-outline .ed-scroll` adds about 290px of left padding. The sheet, which
  is centred, leaps sideways by roughly 130px under the words being read.
  Closing it jumps back.
- **Find.** It pops in, and `.is-finding .ed-scroll` adds the bar's height
  plus 8px of top padding. The whole page drops about 52px at once, with no
  scroll compensation, so the line being looked at moves just as the user
  starts to search for it.

**Principle.** Response with continuity: a panel arriving should explain
where the content went. Content under the reader's eye should not move
because of a control.

**Fix.**
- **Outline.** In `toggleOutline()`, read `sheet.getBoundingClientRect().left`
  before the class toggles and again after it. Then play
  `sheet.animate([{ translate: \`${dx}px 0\` }, { translate: '0 0' }], { duration: baseMs(), easing: readToken('--ease') })`.
  Slide the aside in with `[{ opacity: 0, translate: '-12px 0' }, { opacity: 1, translate: '0 0' }]`
  over `fastMs()`. On close, play the reverse before setting `hidden`.
- **Find.** Keep the bar instant: it is a keyboard surface, by the 09-24 #2
  rule. Stop the page moving instead. In `openFind()`, if
  `scroller.scrollTop > 0`, add the padding delta to `scrollTop` in the same
  task, and subtract it in `closeFind()`. The text then holds still and only
  the room above it changes.

**Cost.** Two transform animations on a button press. The outline's
`padding-left` change is a single layout, not an animated one.

#### 21. Reordering tour stops is the browser's drag, and the drop is a rebuild

**Files.** `ui/tour-edit.ts:556-585` (`chips`), `tour-edit.ts:606-610`
(`dragstart`), `tour-edit.ts:674-680` (`markDrop`), `tour-edit.ts:260-288`
(`paint`), `chrome.css:1400-1407`.

**What happens now.** Chips are HTML5 `draggable`.
- **During the drag.** The browser's translucent drag image follows the
  pointer, the other chips stay still, and a 2px inset edge marks the gap.
- **On drop.** `moveTourStop()` emits `tour`, and `paint()` empties the bar
  (`host.textContent = ''`) and rebuilds it, so every chip lands in its new
  place in one frame.
- **Cancel.** A cancel (Escape, or a drop outside) is the browser's own
  snap-back image.
- **Touch.** Native drag-and-drop is unreliable on touch screens.

The Playlist, one module over, already has the right gesture: a lifted row
on `translate`, neighbours sliding aside, and a settle on drop.

**Principle.** Direct manipulation, and making room. The thing held should be
the chip itself, and the others should get out of its way.

**Fix.** Port `playlist.ts`'s `beginDrag` / `placeHeld` / `finishDrag` /
`settle`, adapted to a wrapping row:
- measure each chip's box at pickup;
- move the held chip by `translate` in x and y;
- pick the boundary with the existing `dropAt()`;
- shift the chips between `from` and `to` by the held chip's width plus the
  gap, using `transition: translate var(--dur-base) var(--ease)` while
  sorting;
- on release, call `moveTourStop()`, then play a FLIP from the release point
  (`settle()`) on the rebuilt chip with the same index.

Drop `draggable` and the `drop-before` / `drop-after` edges. Keep a 4px move
threshold so a click still previews the stop.

**Cost.** About 80 lines, mostly lifted from `playlist.ts`. Wrap is the only
new part: a chip crossing a line end changes rows, so measure boxes and do
not assume one axis.

### Polish

#### 22. Hover submenus open with no intent, and re-pop from fold to fold

`menu.ts:1208-1213` opens a child on the first `pointerenter` of a fold row,
with no dwell. The pointer running down a menu across *Colour* and *Weight*
(adjacent in the connection menu) therefore:
- opens Colour's child with its `ctx-in-side` entrance;
- then `openChild()` closes it, `flushLeaving()` cuts its exit
  (`menu.ts:1305-1307`), and Weight's child pops in fresh.

The aim triangle (09-24 #5) protects the path *to* a child, but not a pass
*over* a fold. **Fix:**
- From a closed state, open a child after a ~90ms hover (a `setTimeout`
  cleared on `pointerleave`). macOS does the same.
- When a child is already open and another fold is entered, swap at once and
  add `is-instant` to the new child, the rule `flyout.ts:99` already applies to
  toolbar flyouts. One panel replacing another has nothing to arrive from.

#### 23. The connection chip grows from its own middle and leaves with no exit

`conn-chip.ts` never sets `transformOrigin`, so its `ctx-in`
(`menu.css:355`) scales about the chip's centre rather than out of the line
it labels. `closeConnChip()` (`conn-chip.ts:110-115`) removes it in a frame,
when every other menu-cloth panel plays `ctx-out`. **Fix:**
- In `place()`, set `node.style.transformOrigin` to `50% 100%` when the chip
  sits above the line and `50% 0%` when it flipped below. Use `is-above` to
  mirror the 3px travel, as `#ctx-menu` does.
- On close, add `is-leaving` with `ctx-out` (or `ctx-out-up`) and remove it on
  `animationend`, with a timer backstop. Mark the node `inert` at once, the way
  `dismiss()` does.

Cheap, and it is the same pattern as the fence-offer origin in 09-24 #16.

#### 24. The Playlist reorder: silent, no Escape, and a mid-settle grab snaps

The reorder itself is good (see below). Three small gaps:
- **Sound.** The card drag sounds `pick` on lift and `tap` on drop. The row
  drag is silent. Call `cue('pick')` in `beginDrag` (`playlist.ts:611`) and
  `cue('tap')` in `finishDrag` when `to !== from`, so the sound fires on the
  same tick as the settle starts.
- **Escape.** It does not cancel a drag. Add a capture `keydown` while
  `drag` is set: `Escape` → `finishDrag(false)`. The settle already flies home
  from the live offset.
- **Grabbing mid-settle.** `beginDrag` cancels every running animation and
  clears `translate` before measuring (`playlist.ts:599-602`). A row grabbed
  again during its 240ms settle jumps to its resting slot under the finger.
  Read the row's live `getComputedStyle(row).translate` first, and fold it
  into `grab` so the row stays where it was drawn.

#### 25. Pausing cuts the soft tier's seek wave to a straight line

`chrome.css:635-658` (and `mobile.css:1243-1255` for the window) say the wave
"flattens all the way to a straight line ... on a transition so it eases both
ways". Under the rule that actually applies, a pause swaps `display` between
the wavy fill and the straight one. The `.np-line-wave-scale` transition has
nothing setting `scaleY` to animate, so the wave cuts flat on pause and back
on play. The comment at `ui/nowplaying.ts:334-335` repeats the claim.
**Fix:**
- Cross-fade instead of swapping display: keep both fills displayed at
  whimsy 0, and transition `opacity` over `--dur-fast`, with the wave at 0
  and the line at 1 while `.is-paused`.
- Correct both comments. The scale approach was dropped for the engine reason
  the comment gives.

#### 26. The scrubber gives no sign it has been caught (P)

`bindScrub()` (`media/transport.ts:52-65`) seeks on `pointerdown`, which is
right. But the line is a 2px stroke in a 14px target
(`chrome.css:586-592`), and nothing changes under a finger, so on a phone
the thumb covers the only thing that moves. **Fix:**
- On `pointerdown`, add `is-scrubbing` to the line and remove it on
  `pointerup` and `pointercancel`.
- Style that class as
  `.np-line.is-scrubbing .np-line-svg { scale: 1 2; transition: scale var(--dur-fast) var(--ease); }`.
  That is the iOS thickening, a compositor-only change. Do the same for
  `.pw-line`.

#### 27. The tour bar changes height between stops

`ui/tour.ts:281-284` hides the caption line on an uncaptioned stop, and
`#tour .tour-caption` clamps a caption to two lines (`chrome.css:868-878`).
The bar is anchored at the foot, so its top edge jumps by up to two lines
on a step, in the frame the camera starts flying. The editor's bar argues
for exactly the opposite ("nothing here is allowed to move",
`chrome.css:1049-1062`). **Fix:** reserve the caption box. Use
`min-height: calc(2 * 1.35 * var(--t-tiny))` on `.tour-where`, and
`visibility: hidden` instead of `hidden` on an empty caption. Alternatively,
FLIP the bar's height change with a `scale` on its top edge.

#### 28. The tour editor's chips lose their scroll on every repaint (P)

`paint()` (`tour-edit.ts:272-279`) throws the whole bar away and rebuilds it
on every `tour`, `items` and `selection` event. The chip block scrolls past
five lines (`chrome.css:1387-1392`), so with a long tour, pressing a chip,
which selects its cards and repaints, puts the block back at its starting
scroll. The chip just pressed may then be off the visible part.
`align-content: flex-end` decides which end that is, so confirm it in a
browser. **Fix:** read `.tour-chips`'s `scrollTop` before
`host.textContent = ''` and write it back after the append, as `paint()`
already does for the caption's caret.

### Already good: leave it alone

- **Menus.** Press, drag and release with `is-hot` rows (`followPress`,
  `releasePress`) behaves like the iOS menu. Keyboard opens, drill-down pages
  and flyout swaps are instant (`byKeys`, `swap()`, `flyout.ts:99`). The aim
  triangle holds a submenu across its siblings. Flipped panels mirror their
  travel, origins are computed after the flip, and `flushLeaving()` keeps one
  `#ctx-menu`.
- **Find.** No entrance and no exit, by the 09-24 rule. A hit flies the
  canvas from the live view on `travelMs()`. On the Feed it scrolls instead
  and lights the tile with a ring that holds and then fades (`is-found`).
- **The connection chip.** It is built once per line and repaints in place.
  It follows a pan 1:1 off `vp.onChange`, and it is hidden by `visibility`
  rather than `display`, so it never re-pops (09-24 #4, done).
- **The Playlist reorder.** It tracks 1:1 with the grab offset measured at
  the press (`grab = clientY − list top`), driven per frame so an edge scroll
  carries the row. Neighbours make way on `translate`. The drop settles from
  the release point, lift and tilt included, on `--ease-back`. A cancel flies
  home. A menu Move up/down slides the rows (`slideFrom`). It is transform
  only, and gated on `--dur-base` and reduced motion.
- **`#nowplaying`.** A track starting mid-exit calls the exit off and the
  CSS transition reverses from where it is (`cancelExit`, `raise`). In and out
  are deliberately asymmetric. Play has a fast, flat press. The scrubber seeks
  on the press, with capture.
- **Tours.** Every stop is a `vp.fit` from the live view, so a fast Next
  re-targets rather than queueing. Entering hides the furniture over
  `--dur-base` while the first flight runs. Both bars' exit timers are
  guarded against a re-open.
- **Feed.** Tiles mount on scroll with no entrance, which is right for
  content. The shimmer sits under the picture and the picture replaces it in
  one frame.
- **Editor internals.** The ribbon folds are measured and cut on resize,
  which is right for a resize. The Vomit lock and the find matches are painted
  as Custom Highlights, with no node or layout. The countdown uses tabular
  figures.
