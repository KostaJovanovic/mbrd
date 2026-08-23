# Interaction feel — ten findings and the order to clear them in

**Written 2026-08-23. This document has an end: it goes to `old/` on the last
commit of the work it schedules.** That is the bargain `research/README.md` asks
of anything added at this level, and it is the same one
`feedback-plan-2026-08-14.md` and `cuelume-2026-08-15.md` kept. It describes its
own items rather than only listing ids, so it *can* disagree with
`open-work-2026-08-14.md` — the end is what keeps that cheap. Nothing here needs
a row in the register while this file is above it; if the work stalls, the fix is
a row in the register and this file going down, not this file sitting here.

**Nothing in here touches the `.mbrd` schema, a generated catalogue, or `SHELL`
in `web/sw.js`.** No new stylesheet, so the three-place list in `index.html` /
`sw.js` / `tests/helpers.js` is untouched. No new element id, so
`tests/element-ids.test.js` is untouched. No inline `style=` and no new inline
`<script>`, so `tests/csp.test.js` is untouched.

## What this was audited against

Apple's *Designing Fluid Interfaces* (WWDC 2018) and the interface-design talks
around it, read as a checklist and applied to a web app: respond on press not on
release, track the finger 1:1 from where it was grabbed, let every animation be
grabbed and reversed, hand the gesture's velocity to whatever animates next,
project momentum to where the throw was going, resist at a boundary instead of
stopping dead, and let a thing leave along the path it arrived on.

It was audited **by reading the source**, which
`old/feedback-plan-2026-08-14.md` proves wrong four times in twelve. Every
finding below therefore carries what would be seen on screen, and the
verification section at the foot is by-eye rather than by-test. Two findings —
**F4** and **F5** — are the kind that document proves are most often misdiagnosed
from CSS alone, because both are about a moment rather than a rule. Open the app
before either.

The audit's own headline is that most of this app is already on the right side of
the line, and the table exists so that nobody re-finds it:

| already correct | where |
| --- | --- |
| Flick glide decays exponentially, integrated from the clock so a dropped frame costs smoothness rather than distance, and dies into a `stopAnim()` every input path already calls | `canvas/viewport.ts`, `glide()` |
| Velocity read across a 90ms window rather than off the last `pointermove` | `canvas/input.ts`, `FLING_WINDOW_MS` |
| The scrubber seeks on `pointerdown`, then tracks 1:1 under capture, with `stopPropagation` on both the down and the move | `media/transport.ts`, `bindScrub()` |
| An item drag keeps the offset from where the card was grabbed, and snapping is applied *during* the drag rather than at release | `canvas/input.ts`, the `mode === 'move'` branch |
| `touch-action: manipulation` globally, `none` on every surface that owns a gesture | `base.css`, `canvas.css` |
| Reduced motion collapses the durations but leaves `--btn-press` alone, so feedback stays instant when motion goes | `tokens.css`, foot |
| `forced-colors: active` restores the borders the palette was carrying | `base.css` |

Two things that look like findings and are not, recorded here so they are not
"fixed" later:

- **No glass chrome.** `backdrop-filter` appears only on `::backdrop` scrims,
  never as a material layer under floating furniture. Apple's material guidance
  wants translucent nav and toolbars; this app's material is *paper*, `#sidebar`
  is opaque `--paper-card` on purpose, and applying that guidance literally would
  be a different app. The one place blur is used as a material —
  `.card-audio.has-cover .play` in `media.css` — already has an argument in
  `item-chrome.css` for why it is dropped while the board is moving.
- **No momentum when an item is dropped.** You place a card, you do not throw
  one. `glide()`'s own header says the same thing about the board: the inertia is
  there to carry movement past the end of the finger, not to travel for you.

---

## The findings

Ten, in the order they were found rather than the order they are worked. The
batches below are the working order and it is different; the reasons it is
different are the only part of this document that is a trap rather than a task.

### F1 — three button families give nothing on press

Thirteen `:active` rules across twenty-five sheets. `#toolbar` and `#zoom-ctl`
have one; the transport bar, the tour and the sidebar do not. On a phone that is
**no feedback at all** between the tap and whatever the command does, which for
Play is the longest gap in the app.

### F2 — hover sticks after a tap on the two sheets that matter

`mobile.css`, `patch.css`, `quality.css` and `privacy.css` all guard their hover
blocks with `@media (hover: hover)`. `chrome.css` and `sidebar.css` do not. Tap a
toolbar button on a phone and it stays lit until you tap elsewhere — a wrong
signal, arriving late, in place of the right one arriving instantly.

F1 and F2 are one defect seen from two sides and are worked as one.

### F3 — the press reaction runs on the hover curve

`#toolbar svg` and `#zoom-ctl svg` carry one transition for both states:
`transform var(--dur-base) var(--ease-back)`. So a press-down takes 240ms — 400ms
at Softish — on a curve that overshoots. The hover *should* spring; a press must
not. A press is the machine saying it heard you, and a bouncy 400ms shrink says
it four hundred milliseconds late.

### F4 — a Mobile board stops dead at its own edges

`_constrainMobile()` is a bare `clamp()`, and `glide()` kills the animation on
the frame it detects `hitEdge`. Drag past the top of a Mobile board and the
finger keeps moving while the board is frozen under it. This is the one finding
here that a person would describe as the app being broken rather than as it being
plain.

### F5 — menus arrive as objects and leave as deletions

`ctx-in` fades and lifts the panel 3px on the way in; every close is
`node.remove()`. Five surfaces share that keyframe — Find, the context menu, the
flyouts, the fence offer, the connection chip — and all five vanish instantly.

### F6 — menus are not anchored to what opened them

`ctx-in` is `translateY(-3px)` from nowhere in particular, so a toolbar flyout
does not come out of the button it hangs off. The idiom already exists in this
codebase and never reached the shared stock: `cards.css` anchors the note toolbar
at `100% 0`, and the sticker pad and the desktop playlist both anchor at
`bottom right`. `openAnchored()` is handed the anchor's rectangle already and
throws it away after placing the panel.

### F7 — the OS's transparency and contrast preferences are not read

Zero occurrences of `prefers-reduced-transparency` or `prefers-contrast` in the
tree. Six blurred scrims. `quality.css` *does* strip `backdrop-filter` — off the
app's own quality dial, not off the OS signal — so somebody who asked their
system for less transparency still gets blur unless they also find the app's
setting.

### F8 — one tracking value across a 2.1× size range

`.pn-title` and `.pv-title` are `clamp(var(--t-display), 8vw, calc(var(--t-display) * 2.1))`
with a flat `letter-spacing: calc(0.01em * var(--ls-scale))`. Positive tracking is
right at 30px and wrong at 63px: large display type reads too loose as it grows
and wants to close up. The `line-height: 1.04` beside it is already doing the
size-responsive half correctly, which is what makes the tracking stand out.

This does not fight `--ls-scale` staying at 1 across the whimsy axis. That rule
is about the *axis* moving type sideways under a reader mid-sentence; this is
about size, and the size is already moving.

### F9 — an animated view move discards the velocity it interrupts — *not doing*

`_animate()` captures the current on-screen value at call time, which is the
correct half: it starts from where the board actually is, not from where the last
animation thought it would be. What it discards is the speed. Catch a gliding
board with "zoom to this item" and the movement drops to zero for a frame before
the new move starts.

**Left alone deliberately.** It is only reachable from a deliberate command — a
button, a shortcut, a menu row — never from a gesture, and the module header
already says direct manipulation stays instantaneous for exactly this reason. The
fix would put a velocity term into `_animate()`'s signature and into all five of
its callers, to smooth a seam that appears when somebody flicks the board and
then presses a button inside a third of a second.

### F10 — no haptics — *not doing*

No `navigator.vibrate` anywhere. The audio leg is well built: eleven cues,
`cuelume/`, one per card on a drop with a capped burst, argued in
`old/cuelume-2026-08-15.md`. The haptic leg is missing, and iOS Safari has no
Vibration API, so building it buys Android alone.

**Left alone deliberately**, and this is the stronger of the two refusals.
Apple's rule for combining senses is that the visual, the sound and the haptic
fire on the same frame or the illusion breaks. `cuelume/engine.ts` spaces cues
twelve milliseconds apart up to an eighty-millisecond lookahead — deliberately,
so a five-card drop is five taps rather than one — and a vibration fired
alongside would be the one channel *not* on that schedule. Doing this properly
means teaching the engine to carry a haptic track, which is a feature and not a
fix. If it is ever wanted, it belongs in `cuelume/recipes.ts` beside `CUES`, per
the rule in `CLAUDE.md`, and it wants its own document.

---

## The order, and why it is this order

Five batches. Each is a commit.

**Batch 1 before anything else, and F1+F2+F3 in one commit.** Not for tidiness —
either one alone makes the app worse. `:active` without the hover guard leaves
touch with a sticky hover and a new press state fighting over the same button.
`:active` while the transition is still `--dur-base var(--ease-back)` gives the
press a four-hundred-millisecond bouncy shrink, which reads as lag arriving where
there used to be nothing, and nothing is faster than late. The three are one
change to what a press feels like and land together.

**Batch 4's two halves are also one commit,** for the mirror reason. Anchoring
the menu to its button without giving it an exit makes the asymmetry *worse* than
it is today: the entrance would make a spatial promise — I came out of this
button — that the exit then breaks by deleting the panel. Today's entrance
promises nothing much, so today's exit breaks nothing much.

**Batch 5 last and alone.** It is the only item here that changes a gesture
rather than a reaction to one, it is the only one that can be got wrong in a way
that makes the board feel worse than it does now, and it is the only one that
wants a state machine rather than a rule.

Batches 2 and 3 are independent of everything and of each other. They are second
and third because they are cheap, not because anything waits on them.

---

## Batch 1 — how a press feels

`web/assets/css/chrome.css` and `web/assets/css/sidebar.css`.

Every task carries a search anchor rather than a line number, because the line
numbers move as the earlier tasks land. **A task whose code no longer matches is
abandoned rather than improvised** — the finding's ground has moved and its
reasoning may not hold.

1. **`chrome.css`** — find `#zoom-ctl svg {`. It sets
   `transition: transform var(--dur-base) var(--ease-back)`. Leave it. Add, after
   the existing `#zoom-ctl button:active:not(:disabled) svg` rule, a second
   transition for the pressed state alone:
   ```css
   #zoom-ctl button:active:not(:disabled) svg { transition: transform var(--dur-fast) var(--ease-in); }
   ```
   `--ease-in` exists already (`tokens.css`) and is the "starts where it was and
   gathers speed" curve `trash.css` asked for. It is the right one here: a press
   is a thing being pushed down, not a thing settling.

2. **`chrome.css`** — same edit against `#toolbar button:active svg`.

3. **`chrome.css`** — find `#nowplaying .np-play:hover`. It sets
   `scale: var(--btn-grow)` and the element's transition already lists `scale`.
   Add:
   ```css
   #nowplaying .np-play:active { scale: var(--btn-press); }
   ```

4. **`chrome.css`** — find `#nowplaying .np-qbtn:hover` and
   `#nowplaying .np-close:hover`. Both change `background` and `color` only. Give
   each an `:active` that takes the background one step further, the way
   `#toolbar button:active` does:
   ```css
   #nowplaying :is(.np-qbtn, .np-close):active { background: var(--paper-3); }
   ```

5. **`chrome.css`** — find `#tour button:hover:not(:disabled)`. Add the matching
   `:active:not(:disabled)` with `background: var(--paper-3)`.

6. **`sidebar.css`** — the sheet has one `:active` and twenty-one `:hover`. Give
   an `:active` to the ones that are buttons a person presses repeatedly, and
   only those: `#menu-btn` / `#mobile-header-edit-btn` / `#mobile-find-btn`
   (find `#menu-btn:hover,`), `#side-close` / `#header-close` (find
   `#side-close:hover,`), `.btn-row button` (find `.btn-row button:hover {`), and
   `.side-tab` (find `.side-tab:hover`). Not the rows, links and fields —
   `.font-row`, `.board-title`, `.field select`, `.side-foot .by` — which are
   surfaces you click *into* rather than buttons you press, and where a press
   state would be a second signal about a thing that is about to change anyway.

7. **`chrome.css`** — wrap every `:hover` rule in the sheet in
   `@media (hover: hover) { … }`. The rules are in several blocks; the anchors
   are `#zoom-ctl button:hover`, `#zoom-ctl button:hover:not(:disabled) svg`,
   `#toolbar button:hover`, `#toolbar button:hover svg`,
   `#nowplaying .np-play:hover`, `#nowplaying .np-close:hover`,
   `#nowplaying .np-qbtn:hover`, `#tour button:hover:not(:disabled)`. **Leave the
   `:active` rules outside the query** — a press is a thing every pointer does.

   The one hover rule that must **not** move inside: the flyout's held-open state,
   the rule whose comment says the button "goes cold the moment you reach for a
   row in its own menu". Check whether it is written with `:hover` or with a
   class before wrapping anything; if it reads a class it is not affected, and if
   it reads `:hover` it is describing a state the flyout driver maintains rather
   than a pointer being over the button, and it stays out.

8. **`sidebar.css`** — the same wrapping, same rule about `:active`.

**By eye afterwards:** on a phone or with the device toolbar in coarse-pointer
mode, tap a toolbar tool and lift — the button must return to rest, not stay lit.
On a mouse, press and hold a zoom button — the glyph must be down *now*, not a
third of a second later, and it must not bounce on the way down. Check at both
ends of the whimsy axis, per the visual audit's rule: at Softish `--dur-base` is
0.4s, which is where a press on the wrong curve is obvious, and at Harsh
`--btn-press` is 1 so only the background changes and it must still change.

---

## Batch 2 — the OS's own preferences

`web/assets/css/quality.css`.

One block, at the foot beside the two universal stops already there. That file is
the right home rather than `base.css` or `tokens.css`: it is where the two
properties that *cannot be handed down as custom properties* are cancelled with a
universal selector, and this is a third of exactly that shape. Its own header
already says so, and it already hosts a `prefers-reduced-motion` block for the
same reason.

9. Add, in that section:
   ```css
   /* The system's own transparency preference, which the quality dial above
      does not answer. Same shape and the same reason as the blur stop: the
      property cannot be handed down, so it is cancelled where it is set. */
   @media (prefers-reduced-transparency: reduce) {
     * {
       -webkit-backdrop-filter: none !important;
       backdrop-filter: none !important;
     }
   }
   ```

10. And the contrast preference, which wants the opposite of a blanket: the
    scrims are already `color-mix(in srgb, var(--ink) 42%, transparent)` and at
    `more` they want to be near-solid so the sheet in front of them has a defined
    edge. Six `::backdrop` rules share that one value. Write it once against the
    selector list rather than six times:
    ```css
    @media (prefers-contrast: more) {
      #ask::backdrop, #credits::backdrop, #inventory::backdrop,
      #timeline-sheet::backdrop, #compose::backdrop, #darkroom::backdrop,
      #pick::backdrop {
        background: color-mix(in srgb, var(--ink) 78%, transparent);
      }
    }
    ```
    Check that list against `dialog.css` and `color-picker.css` before writing
    it — it is copied from them, and a dialog added since would be missing.
    `#viewer` is deliberately not in it; check whether it has a `::backdrop` at
    all, because `viewer.css` sets its blur on something else.

**By eye:** on Windows, Settings → Accessibility → Visual effects →
Transparency effects, off. Open the credits sheet. The board behind it must be
sharp and dimmed rather than blurred.

---

## Batch 3 — tracking that follows the size

`web/assets/css/patch.css` and `web/assets/css/privacy.css`.

`patch.css` is a hand-written stylesheet and is **not** the generated page —
`web/patch.html` is generated by `tools/gen-patch-page.mjs` and must not be
hand-edited, but the sheet it links is ordinary source. No regeneration is
needed; `save.bat` re-runs the generator anyway.

11. **`patch.css`** — find `.pn-title {`. Replace the flat tracking with one that
    closes up as the clamp grows:
    ```css
    letter-spacing: calc(clamp(-0.02em, 0.03em - 0.09vw, 0.01em) * var(--ls-scale));
    ```
    The `8vw` in the font-size and the `0.09vw` here are the same viewport
    driving both, which is what keeps them in step. At a phone width the tracking
    is the 0.01em it is today; past about 560px it crosses zero; at the clamp's
    ceiling it is at −0.02em.

12. **`patch.css`** — find `font-size: calc(var(--t-display) * 1.15)` — the
    section head. It is a fixed multiple rather than a clamp, so it takes a flat
    value: `letter-spacing: calc(-0.005em * var(--ls-scale))`.

13. **`privacy.css`** — find `.pv-title {`. Same edit as task 11. Its own comment
    says it and the changelog's title should sit at the same height, and that
    only stays true if both take the same change.

**By eye:** open `/patch` at a phone width and at a wide window. The masthead
must not look loose when wide. Both pages, side by side at the same width — the
titles must still match.

---

## Batch 4 — a menu that leaves the way it came

`web/assets/css/menu.css`, `web/assets/js/ui/menu.ts`. One commit.

This is the batch with the traps in it. Three, all in `close()`.

**Trap A — the state teardown must stay synchronous.** `close()` does six things
besides removing the node: it closes the child first so it cannot outlive its
parent, it reads whether the node holds focus *before* the node goes, it clears
the type-ahead buffer, it clears `menuOwner`, it restores focus to the opener,
and it calls `onClose?.()` last so the flyout driver writes `aria-expanded` back
onto its button. Only the **node removal** may be deferred. Everything else
happens on the same tick it happens on today. A deferred `onClose` means the
flyout driver can see a panel on its way out as one that is still up, which the
existing comment says in as many words is what the ordering exists to prevent.

**Trap B — a second open must kill the outgoing panel immediately.**
`openAnchored()` calls `close()` first. Flyouts open on hover, so running the
pointer along the toolbar opens and closes panels faster than any exit can play,
and a deferred removal would put two on screen. The outgoing node must be
detached from the module's state the moment `close()` runs — hold it in a
separate `let leaving` rather than in `node` — and a new `close()` or
`openAnchored()` removes any `leaving` node outright before starting its own.

**Trap C — do not drive the exit from `requestAnimationFrame`.**
`old/ui-audit-*` records that rAF stops dead when the window is occluded, which
produced its most convincing false finding. A CSS animation plus an
`animationend` listener is the right shape here — and it needs a `setTimeout`
floor beside it anyway, because an element that never gets a chance to start its
animation never fires the event and the node would leak.

14. **`menu.css`** — find `@keyframes ctx-in`. Give it the anchor:
    ```css
    @keyframes ctx-in { from { opacity: 0; transform: translateY(-3px) scale(0.97); } }
    @keyframes ctx-out { to { opacity: 0; transform: translateY(-3px) scale(0.97); } }
    ```
    and the same pair for `ctx-in-side` / `ctx-out-side`, which travels in X.

15. **`menu.css`** — one rule for the leaving state, beside the five that set
    `animation: ctx-in`:
    ```css
    .is-leaving { pointer-events: none; animation-name: ctx-out; animation-fill-mode: forwards; }
    ```
    `pointer-events: none` is not optional: a panel mid-exit that can still be
    hovered is a row somebody can press on a menu that has already answered.

16. **`menu.ts`** — `openAnchored()` receives `rect` and uses it only for
    placement. After `placeRoot()` has decided where the panel sits, set
    `transform-origin` from the anchor: the panel's own box against the anchor's
    centre, in percent, clamped to `0%–100%` on each axis so a panel that had to
    be pushed sideways to fit still points at its button rather than off its own
    edge. Set it with `node.style.transformOrigin` — **from script, not as a
    `style` attribute in markup**, which is the CSP rule in `CLAUDE.md`: the
    hashes cover elements, never attributes, and `style-src` carries no
    `unsafe-inline`.

17. **`menu.ts`** — `close()`. Everything above `node.remove()` stays where it
    is. Replace the removal with: move `node` into `leaving`, add `.is-leaving`,
    and register both an `animationend` and a `setTimeout` that each remove it
    and clear `leaving`. Give `closeChild()` the same treatment or give it none —
    a child that vanishes while its parent fades is worse than both vanishing.

18. **`menu.ts`** — the re-render path near `if (node) { node.remove(); node = null; }`
    is **not** a close and must not animate. It is the same menu being rebuilt in
    place; fading it out and back in would make a menu that flinches every time a
    row's tick changes. Leave it exactly as it is, and say so in a comment, because
    it is the line most likely to be "made consistent" later.

**By eye, and this one especially — do not check it by reading the CSS.** Open a
toolbar flyout: the panel must grow out of its own button, not out of the middle
of itself. Run the pointer fast along the whole toolbar: exactly one panel on
screen at every moment. Open the context menu, walk into a child, press Escape:
both go, the child not after the parent. Open a menu, press a row that changes a
tick, and watch the menu that stays open — it must not flinch. Tab away from a
closed menu and confirm focus went back to the opener. Then set quality to Light
and do all of it again: `animation-duration: 0.01ms !important` makes every exit
instant, which is correct, and what is being checked is that nothing leaks or
double-opens when the animation is effectively not there.

---

## Batch 5 — a Mobile board that resists instead of stopping

`web/assets/js/canvas/viewport.ts`. Alone.

The velocity half is already built and does not need touching: `input.ts` tracks
a 90ms window and hands `glide()` a speed in screen pixels per second. What is
missing is entirely inside this file.

19. Add the rubber-band rule beside `GLIDE_TAU`, as a pure function with its
    numbers argued the way the constants around it are:
    ```js
    /** How far the board actually follows a finger that has gone `over` past the
        edge, given a screen `dim` to scale against. Diminishing, so it never
        stops following and never keeps up. */
    const give = (over, dim, k = 0.55) => (over * dim * k) / (dim + k * Math.abs(over));
    ```

20. `_constrainMobile()` gains a second behaviour rather than a second function.
    Today it clamps unconditionally. It should clamp *unless the gesture is
    live*, and while it is live apply `give()` to the overshoot instead. That
    means the viewport needs to know whether a finger is down — one boolean,
    written by `input.ts` at the two ends of a pan. Put it on the viewport
    (`vp.dragging`) rather than passing it through four call sites, and set it
    from the same places that already call `stopAnim()`.

21. `glide()` currently ends the animation on the frame it detects `hitEdge`.
    It should instead hand over: when the projected position crosses a bound,
    stop integrating the flick and start a settle back to the bound **from the
    current position and at the current speed**. Not a new animation started from
    the target — that is the jump the whole audit is about. `_animate()` is the
    wrong tool here because it takes a duration and no velocity; write the settle
    in `glide()`'s own `tick`, as a second phase of the same rAF chain, so
    `stopAnim()` still catches it and a finger landing mid-settle still takes
    over where the board is.

22. The lift also needs a settle. If the finger lifts while the board is held
    past a bound and the flick was below `GLIDE_MIN`, `glide()` returns early and
    nothing puts the board back. That path is the one most likely to be missed,
    because it is the *absence* of a throw.

23. `reducedMotion()` already makes `glide()` a no-op. The settle must **not**
    be: with reduced motion the board should still not be left hanging past its
    own edge. Snap it there instead — which is the same distinction `tokens.css`
    already draws by collapsing durations while leaving `--btn-press` alone.

**By eye:** on a Mobile board short enough to fit, and on one long enough to
scroll. Drag past the top slowly — the board follows less and less, and never
stops following. Let go — it comes back and does not overshoot back past the
edge. Flick hard into the top — it decelerates into the boundary rather than
hitting a wall, and settles once. Catch it mid-settle — it takes the finger
immediately, from where it is. Then with reduced motion on: the same drag, and
the board must snap back rather than hang.

---

## Verification

There is no browser-driven suite and this is not the work to add one to: every
item above is a thing seen rather than a value asserted, and
`old/ui-audit-*` is the record of what a driven browser gets wrong about this
app in particular.

What the existing legs do cover, and what to run:

```
npm test          # unaffected by every batch, and that is the point - run it to prove so
npm run lint
npm run typecheck # batches 4 and 5 only
npm run build     # batches 4 and 5 only
```

Batches 1, 2 and 3 are CSS alone and cannot fail typecheck or build. Run
`npm test` on them anyway: three tests read the stylesheets — `tests/csp.test.js`,
and the element-id and icon-name pairs — and a green suite is the cheapest
evidence that a sheet edit stayed inside its own sheet.

Batches 4 and 5 want the by-eye lists above run at **both ends of the whimsy
axis**, per `old/visual-audit-2026-08-12.md`'s closing rule: a literal is
indistinguishable from a token at the value it was copied from, and obvious
everywhere else. Batch 4 additionally wants a pass at Light quality, for the
reason its own list gives.

## Reporting

Nothing here touches the `.mbrd` schema, a generated catalogue, or the
service-worker cache. Say so in each commit message rather than leaving it to be
inferred — `CLAUDE.md` asks for those three to be called out explicitly, and
"none of the three" is the useful answer when it is true five times running.
