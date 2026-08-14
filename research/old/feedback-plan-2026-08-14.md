# Twelve things, from looking at it — a plan

*Written 2026-08-14, after the timeline landed and the maintainer opened the app
and used it. Nothing here is speculative: every item is something that was seen
on screen or asked for out loud. Nothing here is started.*

**Who this is for.** Whoever picks the work up next, with none of the
conversation it came out of. Each item below says what is wrong, where it lives,
what "done" means, and — where it matters — what the trap is. Read *Before you
start* first; two of the rules there are absolute and one of them is about not
destroying somebody's data.

---

## All twelve were built, the same day — and where this plan was wrong

*Added on the last commit of the work. The body below is left exactly as it was
written, because the useful half of a carried-out plan is where it turned out to
be mistaken, and a document quietly corrected after the fact teaches nothing.
Where this section and the body disagree, this section is what happened.*

**Four items were diagnosed wrongly here, and one had a false premise.**

- **11 — the menu corner.** The plan said *"the arithmetic is right and something
  else is wrong"* and pointed at a scroll container. It was not right. The lines
  it quoted were `#search` / `#search-field`, a different element; `.ctx-item`
  used `--radius-sm`, a fixed ratio of the outer radius rather than a function of
  the padding. It was correct by coincidence at the middle whimsy tier and five
  pixels short at the soft one — which is the whole reason it only ever looked
  wrong on one setting, and why reading the CSS at the default tier found
  nothing. Now `max(0px, calc(var(--radius) - 5px))`.
- **4b — the More button not closing.** The plan blamed `ui/toolbar.ts:73`. That
  is a red herring. The menu's own outside-press listener closes on
  `pointerdown`, in the capture phase, and a button that opens a menu is
  *outside* that menu — so the second tap had already closed it and the `click`
  a few milliseconds later reopened it. **No toggle written in the opener could
  ever have worked**, because by the time the opener runs there is nothing left
  open to find. The fact has to survive the gap between the two events, which is
  what `justDismissed()` in `ui/menu.ts` is.
- **4a — the More menu rendering wrongly.** Two causes, both real. `.is-flyout`
  squares the *top* corners and drops the top border, which is right under a bar
  at the top of the window and exactly backwards for a panel flipped above a bar
  at the bottom — so the phone's menu had its rounded edge pressed into the bar.
  And the `max-height` counted down from `--toolbar-h`, the height of a bar the
  phone's menu has nothing to do with, so it was capped against the wrong end of
  the window and could not fit either way. The cap is measured off the panel's
  own anchor now.
- **5 — the scope of the deletion.** The plan listed the `versions` key and its
  readers. It did not know about the sidecar mechanism on the pack side —
  `versionSidecars`, `withoutVersionData`, `versionFile`, `VERSIONS_DIR` — or the
  unpack-side reader that put the documents back. All of it went. The plan's
  *trap* paragraph was right and worth having: preserving the data would have
  kept every reader alive in exchange for something nothing could reach.
- **12 — the premise.** There are **five** `type: 'select'` rows in the settings
  panel, not six; the sixth was already a picker. More importantly, the item as
  written would have been a net loss. `ui/menu.ts` provided about half of what a
  native select does: no type-ahead, no Home/End, and `role="menu"`/`menuitem`
  are not `listbox`/`option` — a screen reader would have announced *"menu, menu
  item"* where the native says *"combo box, Units, Millimetres, 1 of 2"*. The
  plan's own instinct was right ("the item most likely to be a net loss if done
  for tidiness alone") and its ordering was wrong: the prerequisite was never
  items 10, 11 and 4, it was the keyboard and the roles.

**What 12 became.** The three keyboard gaps were filled in `ui/menu.ts`, which
every menu in the app now benefits from, and exactly one control was converted:
the note toolbar's font, in `canvas/notes.ts`. That one earned it — a native
dropdown takes focus, and that bar sits over an editor which must not lose it, so
three separate workarounds existed only to hold the native control at arm's
length and all three were deleted with it. The rest stay native, and the rule is
written into the `PickerControl` block in `ui/settings-schema.ts`: **a dropdown
stops being native when there is something a native one cannot do, not when it
looks different from its neighbours.**

**Two smaller divergences.** Item 9's standalone *Optimize* row was deleted
rather than kept — the inventory sheet's footer already offers it with the
explanation attached. Item 6 turned `ui/timeline-strip.ts` into
`ui/timeline-view.ts`, because one module now decides between the strip and the
phone's sheet and splitting them would have been an import cycle.

**Item 8 is the one thing left open.** *Undo history* was renamed to *How much
can be undone*, as the plan instructed, and the plan's own suspicion stands: with
the Timeline showing the marker and the step count on screen, the only part of
that toast the strip does not say is how many items the undo stack is holding —
a memory question that belongs beside *What this board weighs*. It was raised
rather than decided, which is what the plan asked for.

---

## Before you start

**Three standing rules, from the maintainer, that outrank anything below.**

1. **Never `git push`.** Commit when asked and stop there. `save.bat` offers to
   push at the end; decline it. Approval for one push never carries to the next.
2. **Never write patch notes.** `patch-notes.md` at the repository root is the
   maintainer's prose. If `tests/patch.test.js` goes red because `VERSION` has
   moved past the newest `version:` span, **report it and leave it**. It is red
   right now for exactly that reason (VERSION 0.198, notes end at 0.197) and
   that is not yours to fix.
3. **Look at it in a browser.** There is no browser-driven suite here, and at
   least four of the items below are things `npm test` cannot see. Claude in
   Chrome is available. `python tools/serve.py` serves on 6273; `npm run dev`
   is the esbuild watch that makes an edit visible on refresh.

And the ordinary ones from `CLAUDE.md`, which the items below will each brush
against: `web/404.html` is a byte-for-byte copy of `index.html` and is remade by
`save.bat` (or by hand — `cp web/index.html web/404.html`); `web/patch.html` is
generated by `node tools/gen-patch-page.mjs`; a new stylesheet needs an entry in
`SHELL` in `web/sw.js`; icons are `<symbol>`s in `web/assets/icons.svg` and a
misspelled id fails silently.

---

## The order to do them in

Not the order they were said in. Three of them unblock others, one of them
deletes code that later items would otherwise have to be written around, and one
is far larger than the rest.

```
5  remove snapshots      ← first: deletes code items 6 and 9 would touch
1  strip position        ┐
3  connector lines       ├ the strip, together, in one sitting in front of a browser
2  icons and labels      ┘
6  Timeline on mobile    ← needs 1-3 settled, since it is the same module
11 menu corner radius    ┐
10 palette swatch side   ├ the menus, together
4  mobile menu bug       ┘
12 replace every <select> ← last, and only once 10, 11 and 4 are right
7  inventory preview     ┐
8  rename Undo history   ├ small, independent, any time
9  rename About / drop Optimize ┘
```

---

## 5 — Remove the snapshot feature outright

**The one that deletes rather than adds, and worth doing first** so that
everything after it is written against the smaller codebase.

Board versions shipped in v0.197 — **one day before this plan** — and the
timeline has since made every reason for them redundant. Undo now survives a
refresh, every step is a point you can return to, and any step can be named. The
maintainer has agreed to remove them, having been told plainly that boards saved
in the last day lose their snapshots.

**Delete:**

- `web/assets/js/ui/versions.ts` and `tests/versions.test.js`, whole files
- The automatic ring in `main.ts` — the `AUTO_VERSION_MS` block hung off the
  `autosaved` event, around line 412
- `saveVersion`, `forgetVersion`, `restoreVersion`, `boardVersions`,
  `trimVersions` in `state.ts`, and the `versions` re-exports
- `board.versions` in `board-model.ts`, the `BoardVersion` type, `VERSION_RING`
  and `VERSION_KEPT_MAX`
- The `versions` key from `serializeBoard()` and `normalizeBoard()` in
  `board-schema.ts`
- `versionHashes()` and **all three of its readers**: `versionItems()` in
  `storage/mbrd.ts`, the version walk in `referencedHashes()` in
  `storage/session.ts`, and the line in `ui/inventory.ts`
- The `versions` command in `commands/view.ts` and its row in
  `ui/settings-schema.ts`
- The `versions` event from `BusEvents` in `board-store.ts`

**Keep:** `nameStep()` in `timeline.ts`, which is what a named point is now, and
the call to it that used to sit inside `saveVersion()` — move that to wherever
naming a step ends up being offered from (see item 6).

**The prize, and say so in the commit:** the reference union goes from four
members to three. One of the four places that can silently delete somebody's
photograph stops existing.

**The trap:** do not compromise by *preserving* versions — reading them from old
files and writing them back untouched. That keeps `versionHashes` and all three
readers alive, which is the entire cost of the feature, in exchange for data
nothing can reach. It is the worst of both and it is the obvious-looking middle.

**Also update:** the `### versions` section of `research/docs/mbrd-format.md` —
it should say the key is no longer written, is ignored on read, and why.

**Done when:** `npm test`, `typecheck` and `lint` are clean, and
`grep -rn versionHashes web/assets/js` finds nothing.

---

## 1 — The strip must not lie over the board

**What is wrong.** `#timeline-strip` is `left: 0; right: 0` — a full-width bar
pinned to the bottom edge, over the top of everything at that edge.

**What it should be.** Fitted into the gap *between* the left controls and the
right cluster, the way `#nowplaying` already is. That bar computes its own
gutters and they are the pattern to follow — `web/assets/css/chrome.css` around
line 257:

```css
--np-left:  calc(max(16px, env(safe-area-inset-left)) + 3 * var(--chrome-button-w) + 8px + var(--np-gap));
--np-right: calc(max(16px, env(safe-area-inset-right)) + var(--np-corner-w) + var(--np-gap));
```

Take the same two, or better, factor them into shared custom properties so the
player and the strip cannot drift apart when a button is added to either
cluster. A shared `--foot-left` / `--foot-right` in `chrome.css` would be the
honest shape.

**Watch for.** `#nowplaying` also has rules that widen its gutter when the
sidebar or the header panel is open (`#sidebar.is-open ~ #nowplaying`). The strip
needs the same, or it will slide under the panel.

**And re-check the stacking.** With the strip no longer full-width it may no
longer need to push the player up at all — they may simply sit side by side, or
the strip may want to be the thing that steps up. Decide in front of the browser
with something playing. If the push goes away, the ordering constraint in
`CLAUDE.md` and the long comment over `#timeline-strip` in `index.html` both
need rewriting rather than leaving to rot.

**Done when:** the bin and the zoom cluster are reachable with the strip open,
at a narrow window as well as a wide one, and the player is reachable while
something is playing.

---

## 3 — The connectors between steps do not join up

**What is wrong.** The rule is in `web/assets/css/timeline.css`:

```css
#timeline-strip .tl-step::before { left: 0; right: 50%; top: 50%; height: var(--hairline); }
```

The intent was that each step draws the line from its own left edge to its own
centre, so two adjacent steps meet exactly at the boundary and no line can be a
pixel out from the dot it belongs to. It does not look right on screen.

**Likely causes, in the order worth checking:** the dot is centred by `place-items`
inside a 22px grid cell, so `50%` is the *cell's* middle and the dot's middle
only if the dot is exactly centred; `top: 50%` places the line's top edge at the
midpoint rather than its centre, so it sits a half-hairline low; and the flex
`gap: 0` means the cells touch, but the first-child rule hides one segment
without anything drawing the other half.

**Do not fix this by reading the CSS.** Open it, zoom the browser to 400%, and
look at where the line actually lands relative to the dot. The plan's guesses
above are guesses.

**Done when:** the line is continuous through a run of steps, centred on the
dots, at 100% and at 200% browser zoom, in both light and dark.

---

## 2 — Steps should be icons that say what happened, to what

**What is wrong.** Every step is an identical dot, and hovering says only
`Move`. Fusion's timeline shows a glyph per feature type and names its subject,
and that is what makes a long history readable at a glance.

**Two halves, and the first is the harder one.**

**(a) A step has to know what it touched.** Right now it carries `label` — the
string `commit()` was given, like `Move` or `Add` — and a `delta` keyed by item
id. The name is recoverable from the delta: parse either side of a changed pair
and read `name`, falling back to the type (`image`, `note`). Do that in
`timeline.ts` as a `describeStep(step)` returning `{ kind, subject }`, rather
than storing a second copy on the step — the delta already holds it, and a
stored copy would go stale the moment a step is rebuilt.

For a step touching several cards, say the count: *Moved 6 cards*.

**(b) A kind needs an icon.** The label strings are the app's own and finite —
`Add`, `Move`, `Resize`, `Nudge`, `Rename`, `Delete`, `Restore`, `Rearrange`,
`Align *`, `Distribute *`, `Connect`, `Edit note`, `Recolour swatch`, `Lock`,
`Tag`, `Unstick`, `Optimize`. Map label to icon in one table in
`ui/timeline-strip.ts`. Reuse symbols that already exist in
`web/assets/icons.svg` wherever possible — `i-swatch`, `i-link`, `i-sticker`,
`i-trash` and the rest — and add new `<symbol>`s only for the kinds with no
existing glyph.

`tests/icons.test.js` checks references against the sprite in both directions,
so a misspelled id fails the suite rather than silently leaving a hole. Good.

**The hover text** becomes `Moved Sunset.jpg`, `Deleted Kitchen note`,
`Rearranged 14 cards`. Past tense, because a step is a thing that happened.

**Sizing.** The dots are 9px and an icon is not legible at that size. The step
cell will need to grow — 22px cell to something like 26–28px with a 14px icon.
That changes the strip's height, which feeds back into item 1's gutters and the
`--tl-h` measurement. Do item 1 and this in the same sitting.

**Done when:** a board with a dozen different kinds of edit shows a dozen
distinguishable icons, and every one of them names its subject on hover.

---

## 6 — Rename to Timeline, and give the phone one

**Rename** `History` to `Timeline` everywhere it is user-facing: the button in
`ui/settings-schema.ts`, the `.tl-title` in `index.html`, the aria-labels, the
close button's title. The command stays `timeline`, which it already is.

**The phone.** The desktop-only decision was about the *strip* — a horizontal
list of three thousand steps on a 430px screen — and not about the feature. The
maintainer wants it available on mobile in a form that suits a phone.

**The shape:** a vertical sheet, one row per step, newest at the top, each row
carrying the icon and the sentence from item 2 and the time. Tapping a row takes
the board to that point and closes the sheet. This is the same data and the same
`goTo()`; only the presentation differs.

**Where it should live.** `ui/inventory.ts` is the model to copy — it is a
`<dialog>` report built by one module, opened from a `cmd`, and it already
solves the sheet problem on both layouts. Do *not* build a second menu
implementation; `ui/menu.ts` renders every menu in the app.

**The media query in `timeline.css` currently reads `display: none` below
720px.** That goes, replaced by: strip on wide, sheet on narrow, one module
deciding which to build.

**A place to name a step** belongs here too, now that item 5 has taken away the
only way to name one. A long-press or a row action offering *Name this point*,
writing through `nameStep()`.

**Done when:** the Timeline opens on a 390px viewport, is scrollable, is
readable, and takes the board somewhere when tapped.

---

## 11 — Menu corners and the bottom row's hover

**What is wrong.** The hover highlight on the last row does not sit correctly
inside the menu's rounded corner.

**Where.** `web/assets/css/menu.css`. The menu has `padding: 6px` and
`border-radius: var(--ogee)` (line ~38–40); a row has
`border-radius: max(0px, calc(var(--ogee) - 6px))` (line ~55), which is the
correct nested-radius formula — inner radius equals outer minus the gap. So the
arithmetic is right and something else is wrong: a scroll container that clips
without a radius, a separator adding to the padding, or the last row not
receiving that rule at all.

**Check** whether the menu scrolls (`overflow` around line 1039 in `menu.ts`
mentions it) — an `overflow: auto` box with no radius of its own will square off
the corners of everything inside it regardless of what the rows say.

**Done when:** hovering the first and last rows of a menu, with and without
enough entries to scroll, leaves no gap and no overflow at any corner.

---

## 10 — Palette swatches on the right

**What is wrong.** A `swatch` on a `MenuEntry` is drawn in the menu's **icon
column**, which is on the left. The maintainer wants them on the right for the
palette dropdown.

**Where.** `ui/menu.ts` around line 984 — the note there says a swatch "takes
that column instead", which is the behaviour to change. `MenuEntry.swatch`
accepts a string or an array of strings (the array draws a split chip, which is
what a whole palette looks like).

**Do not move the icon column.** Add a trailing swatch position and use it for
the palette rows specifically — the note tints and the connection colours, which
also use `swatch`, may well be right where they are. Look at all three in the
browser before deciding whether this is a global move or a palette-only one; the
maintainer said "palette drop down menu", which reads as the latter.

**Done when:** the palette dropdown shows its three-band chips on the right,
aligned down the menu's right edge, and the other swatch users are unchanged or
deliberately changed.

---

## 4 — The mobile More menu renders wrong and will not close

**What it is.** The "new type of menu" is `openAnchored()` in `ui/menu.ts` — a
menu opened against an element's rectangle rather than at a cursor. Three things
use it: the toolbar flyouts (`FLYOUTS` in `ui/flyout.ts` — `rearrange`,
`add-note`, `add-swatch`, which is the palette one), and `cmds.moreTools()` in
`commands.ts` around line 553, which is the phone's **More** button.

**Two separate bugs.**

**(a) It does not render correctly on mobile.** Unknown why; go and look. The
one lead in the code is the comment at `ui/menu.ts` line ~1072: *"The phone's
More button is on a bar pinned to the bottom"* — so the anchoring logic already
has a special case for upward-opening menus, and that is the first place to
suspect.

**(b) Tapping the button again should close it.** It does not. Note
`ui/toolbar.ts` line 73: `if (btn.dataset.cmd === 'more-tools') return;` — the
toolbar deliberately skips its own handling for that button, which is likely
half the reason the second tap does not toggle. The fix is a genuine toggle:
if the menu is open *and was opened by this button*, close it; otherwise open.
`ui/menu.ts` has a `close()` and tracks the `opener` element, so both halves of
that test already exist.

**Done when:** on a 390px viewport, More opens a correctly positioned menu,
tapping More again closes it, and the same is true of the three flyouts.

---

## 12 — Replace every native `<select>`

**The largest item on the list, and it is last for a reason:** it multiplies
whatever is wrong with the custom menus by the number of dropdowns in the app.
Do not start it until 10, 11 and 4 are right.

**What there is to replace:**

- Six `type: 'select'` rows in `ui/settings-schema.ts`, rendered by `ui/panel.ts`
- One literal `<select>` in `index.html`
- `document.createElement('select')` in `ui/appearance-controls.ts` (line ~147)
  and `canvas/notes.ts` (line ~304)

**The shape.** A button that shows the current value and opens `openAnchored()`
with one row per option, `check` on the current one. That is exactly what the
existing menu already does; the work is a small wrapper and then the
substitutions.

**Three things a native `<select>` gives you for free** that the replacement has
to earn back, and none of them are optional:

- **Keyboard.** Arrow keys move, Enter picks, Escape cancels, typing a letter
  jumps. `ui/menu.ts` already does arrows and Enter and Escape; type-ahead it
  may not.
- **Screen readers.** A native select announces itself as a listbox with a
  value. The replacement needs `role="combobox"`, `aria-expanded`, and the
  option rows need `role="option"` with `aria-selected`.
- **Form semantics on a phone.** iOS renders a select as a native wheel that
  many people find *easier* than a list. Check on a real phone viewport before
  replacing the ones in the settings panel, and be willing to leave those alone
  if the custom one is worse there. This is the item most likely to be a net
  loss if done for tidiness alone.

**Done when:** every dropdown in the app looks the same, is keyboard-operable,
and announces itself; or, where it was left native, there is a comment saying
why.

---

## 7 — Preview and jump from *What is in this board*

**What is asked.** Hovering a row in the inventory sheet pops a small preview of
that item; clicking it zooms the board to it.

**The complication, and it needs a decision.** The rows in `ui/inventory.ts` are
**files, by content hash** — the ten heaviest — not cards. One file can be used
by several cards, and a file can be used by none at all (that is the *orphans*
section, which is the point of the report). So:

- Find the cards using that hash via `itemHashes()` over `board.items`.
- **No card:** no preview, no jump. An orphan has nothing to show; say so rather
  than offering a dead control.
- **One card:** preview it, jump to it.
- **Several:** preview the first and jump to it. A count badge — *used by 3* —
  would be honest, and cycling on repeat clicks would be better still if it is
  cheap.

**The jump.** `cmds.zoomToSelection()` exists and `select()` is in
`board-store.ts`; selecting the card and calling that is the whole of it. The
sheet has to close first, or the zoom happens behind a dialog.

**The preview.** The asset's Blob is in `storage/assets.ts` via `getAsset()`. An
`<img>` from an object URL is the cheap version — **and the URL must be revoked**
when the preview goes, the way `ui/viewer.ts` revokes its own. A leaked blob URL
holds the whole file.

**Done when:** hovering an image row shows the picture, hovering an orphan shows
nothing, and clicking takes you to the card with the sheet out of the way.

---

## 8 — *Undo history* is ambiguous

**Where.** `ui/settings-schema.ts` line ~833:
`{ cmd: 'history-state', label: 'Undo history' }`.

**What it actually does.** `cmds.historyState()` in `commands/file.ts` toasts
*"18 back, 3 forward, holding 412 items"* and logs the same to the console. It
is a **readout**, not an action — the label reads like a button that will undo
your history, which is close to the opposite.

**Rename it to what it is.** Something in the shape of *How much can be undone*.
Whatever is chosen, it should not begin with a verb, because every other button
in that section does something and this one only reports.

**Worth reconsidering entirely** once the Timeline is on screen: the strip shows
where the marker is and how many steps there are, which is most of what this
toast says. It may be a row that no longer needs to exist. Raise it rather than
deciding alone.

---

## 9 — Rename *What is in this board*, and check *Optimize*

**The rename.** `ui/settings-schema.ts` line ~724. The current label is a
question and sits among buttons that are not. Something shorter and nominal.

**The Optimize question.** There are two ways to reach it: a standalone
`{ cmd: 'optimize', label: 'Optimize' }` row in the same section, and a button
inside the inventory sheet itself (`id="inventory-optimize"`). The sheet's
version has context around it — it has just told you how much is stored and how
much is rubbish — and the standalone row is the one the inventory sheet was
partly built to give a reason to.

**Check whether the standalone row still earns its place.** If the answer is
that Optimize should always be reached through the report that justifies it,
delete the row. If somebody who knows what Optimize does should be able to press
it without reading a report first, keep it. Either is defensible; what is not is
leaving two entry points because nobody looked.

---

## What to check in the browser before calling any of this done

None of the following is covered by `npm test`, and all of it is cheap to look
at once the dev server is up:

- The strip with the sidebar open, with the header panel open, and at a window
  narrow enough that the two clusters nearly meet
- The strip with something playing, so the player and the strip are both up
- A rebuild: right-click an Arrange step, pick a different arrangement, and
  watch whether the board flickers or jumps
- Scrubbing back and forth across a checkpoint boundary (every 50 steps) on a
  board with a few hundred edits
- Every one of the four menus that use `openAnchored()`, on a phone viewport
- Dark and light, and the whimsy dial at 0, 1 and 2 — `tokens.css` prints three
  quite different rooms and the strip has only ever been seen in one of them
