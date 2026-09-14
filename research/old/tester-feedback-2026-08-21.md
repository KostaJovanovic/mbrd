# What the testers said

> **2026-09-14 audit:** the wordmark is built (`ui/wordmark.ts`), and an empty
> PNG or PDF export is refused with a toast. The maintainer decided on
> 2026-09-14: no audio card on the starting board, and dark mode and
> colourblind mode wait.

Open work. A Discord session on 2026-08-19 with two people using the app for
the first time on machines that are not this one — Linux/Brave, macOS/Safari,
macOS/Chrome — plus one bug found by panning until the arithmetic gave up.
Transcribed here on 2026-08-21 because a chat log is not a work list and the
useful half was about to scroll away.

**What this is worth.** Almost none of it is a defect. It is mostly the two
things a person who wrote the app cannot see for themselves: what is
discoverable on first contact, and what is inconsistent in a way that reads as
broken rather than as a choice. Weight it accordingly — "some things fade when
the theme changes and some snap" is not a bug report, it is somebody noticing
the seam, and the seam is real.

Four items have been carried out. Everything below them is untouched, and
where a line says the code has not been traced yet, it means exactly that:
nothing here should be taken as a claim about where the fix goes.

---

## Done

### The far lands — the grid comes apart at extreme pan

> "kad odes negde u kurac na canvasu — lose racuna"

Reported with a screenshot: the dot lattice at uneven spacings, some dots
doubled and dark, some gone. Reproduced by panning about nine billion pixels
right.

**Cause.** `paintGrid()` writes the world origin's screen position straight into
`background-position`, and that number grows with the pan without bound.
`background-position` does not grow with it: the browser resolves it to a
fixed-point number that runs out a little past 33 million CSS px. Each of the
eight gradient layers has its own tile and so loses a different amount, which is
why the failure is not the lattice sliding — it is the lattice coming apart.

**Fix.** Reduce the offset into the tile before writing it. A tiled background
is periodic in its own size, so this is the same picture written in numbers the
browser can still hold — exact, not a mitigation. `canvas/grain.ts` was already
doing this for #grain and the helper was private to it; it is now `wrap()` in
`util.ts` and both layers share it. `tests/wrap.test.js` guards the two
properties that matter, neither of them obvious from the one-liner: the result
is inside `[0, tile)`, and it differs from the input by a whole number of tiles.

Writing that test turned up two flaws in the helper as it stood in `grain.ts`,
both harmless at the one decimal place the callers write and both now gone: the
`((n % tile) + tile) % tile` form put values that were *already* in range
through a round trip that did not always come back (`wrap(39.9, 40)` returned
39.900000000000006), and it handed back `-0` for every negative whole multiple
of the tile — which is the origin itself, the offset most worth getting right.

### "could be smaller" — not the bug it looked like, sitting next to one

> "could be smaller je jako kul sta to znaci"

Said cheerfully, with a screenshot. This is `boardWeight` in `commands/file.ts`,
the Debug row that answers "is optimising this board worth it". The tester's
board had nothing on it that could be optimised, and **that message is correct
in that state** — the confusion was about a true sentence, not a wrong one, and
there is nothing to repair there.

What was wrong was the number in it. `plan.total` is a count of *bytes*
(`plan.total += asset.size` in `optimize/optimize.ts`), and `plan.done` is a
count of *files*, and this row printed both bare and side by side:

    12 files, 48.2 MB in this browser. 50528374 could be made smaller, 3 already are.

`optimize/ui.ts` reads the same field through `formatBytes()` and always did.
`plan.total` was also never the number that sentence claimed: it counts
everything not already done, video included, and video goes in `plan.skipped`
precisely *because* it is never encoded.

It survived this long because of how the two failures overlap. On a board with
nothing to optimise the total is 0 — and 0 bytes and 0 files are the same three
characters. The one state that made the sentence read oddly enough to be
reported was the one state in which the actual defect was invisible.

Now: the picture and sound jobs are counted, their weight is formatted, video is
reported as left alone, and the empty cases say so plainly.

### Exporting an empty board wrote an empty file and said nothing

> "exportuje i empty table sto nije kul daj warning table empty"

A board with nothing on it packs and writes perfectly happily — the format does
not require anything to be on the paper — so the failure was silent by
construction. You get a `.mbrd`, it is the right size for what it holds, and you
find out it was empty when you open it somewhere else.

**A question, not a refusal.** An empty board is a real thing to want to keep:
the title, palette, grid and every layout setting are in that file, and a board
saved with nothing on it is how you carry a look to the next one. Refusing would
be the app deciding it knows better about the one case where it plainly does
not. So Export, Export As and Share now ask, and "Export anyway" writes it.

Two things worth knowing about where it went. The guard is in `commands/file.ts`
and not in `storage.ts`, because `ui/` sits above storage and `storage.ts`'s
injected `prompt` answers `'cancel'` when unwired — gating an export on it there
would mean no export at all in a test. And emptiness is `hasContent()` from
`onboarding.ts` rather than `board.items.length`, so a board holding nothing but
fences and the hint ghosts counts as the empty board it looks like. The
`hasContent()` short-circuit also means a board with anything on it never
reaches `ask()`, which matters for the same headless reason.

Not extended to Export as PNG/PDF. The same argument applies to a picture of an
empty board and it is a one-line follow-up, but it was not what was reported.

---

### The far lands' larger sibling — decided, and the decision was to mark it

The grid was the visible half. The other half is `#world`, which carries the
entire pan as a CSS `translate()`:

    viewport.ts:1034   translate(${(-this.pan.x * z).toFixed(3)}px, ...)

Transforms are composited as 32-bit floats. Past 2^23 — about 8.4 million px —
the gap between representable values exceeds one pixel; at the nine billion the
report was made at it is over a thousand. So out there the *items* are misplaced
and jitter under a pan, and no amount of care in `grid.ts` touches that. The
screenshot did not show it only because that stretch of board was empty.

Three ways out were on the table: clamp the pan, rebase the origin as it grows,
or leave it. **The decision was to leave the board unbounded and put something
at the edge instead.** Clamping would have traded a place nobody reaches for the
word "infinite", and the word is worth more; rebasing is a lot of risk — the
item store, the undo ledger and the `.mbrd` coordinates — for a place no board
has ever had an item on it.

So `canvas/farlands.ts`: cross a circle of radius 2^23 from the inside and a
card is placed where you crossed. 2^23 and not a round number, because it is the
last magnitude at which a 32-bit float still resolves single units, and so the
last place a card can be put and still be drawn where it was put. One tier out
and the marker would suffer the drift it exists to mark.

What it is not, each on purpose: **not an item** (never in `board.items`, so not
saved, exported, selected, deleted, or caught by Rearrange and Fit — a board
that has been out there is byte-for-byte one that has not); **not screen-pinned**
(it sits in `#world` at real coordinates, so you can look away and come back);
**not persisted** (forgotten on reload). It is `aria-hidden`: a floating-point
joke for somebody who panned there deliberately is not something to announce to
somebody arriving with a keyboard.

Two traps, both found while building it:

- **Placement is edge-triggered, not level-triggered.** The card is taken down
  once it has been panned fully off screen, and "off screen" happens while still
  far outside the circle — so a level trigger would place another at the new
  centre on the next frame, and twenty frames later it is a plaque bolted to the
  middle of the screen that teleports as you pan. `armed` is what prevents that.
  Earning it twice means coming home and setting out again.
- **The take-down test is box against box, not a distance.** The two agree along
  the axes and disagree everywhere else: leave cornerways and a radius test
  calls the card gone while a third of it is still on screen. `boxInView()` is
  pure and exported for exactly this reason, and `tests/farlands.test.js` runs
  every case off-axis, because straight out along x is the case that gets tried
  by hand and so the one that cannot break unnoticed.

Still true, and worth writing down so it is not rediscovered as a bug: **past
2^23 the board really does come apart**, items included. That is now a marked
edge rather than an unmarked one, not a fixed one.

---

## Defects

### ~~Join stays armed~~ — done, and the rule was reversed

**Carried out.** A completed pair now puts the tool down, and **Shift held on
the press that completes it** keeps the tool armed for the next one. The run of
joins is not gone; it moved onto a modifier, so the cost sits with the person
drawing five lines rather than with the person drawing one.

Four places, one rule:

- `connectStep()` (`ui/toolbar.ts`) grew a fourth field, `disarm`, and a fourth
  argument, `sticky`. It stays pure and stays the only place the five cases are
  written — a caller deciding for itself would be a second copy that disagreed
  the first time a case was added. `disarm` is true on exactly one line: the
  press that completes a pair, without Shift. Parting two cards counts as
  completing one, because `toggleConnection()` reads that press both ways and
  the person has finished the same sentence either way.
- `connectTap()` disarms *after* `toggleConnection()`, not before: `setArmed()`
  clears the pick and takes the draft line down.
- `canvas/input.ts` hands `e.shiftKey` through. It is read off the event and not
  off `intent`, because the connector answers the press before `pressIntent()`
  runs — and while the tool is out, Shift's additive-selection reading is not
  the one anybody is asking for.
- `commands/connections.ts`: arming with two or more cards selected no longer
  arms at all. That press asked a whole question and `joinAll()` gave a whole
  answer; a mode left standing after it is the tool waiting for an instruction
  nobody has. Exactly one selected still arms, because half a pair is a question
  still open, and the arming toast is the one line in the app that teaches Shift.

The cursor is now the tool's own mark rather than `crosshair` — two ends and a
line between them, drawn as a white pass under a dark one so it stays legible
over a photograph and over bare paper, `crosshair` kept as the fallback. It is a
data: URL in `canvas.css` rather than a file in `assets/img`, at 400 bytes, so
the mode's mark cannot be the one asset that is missing at the moment the mode
turns on.

`tests/toolbar.test.js` carries the reversal: the old test asserting that
*nothing* in the step disarms is gone, replaced by one that a completed pair is
the **only** press that does, and two that Shift keeps the tool and is otherwise
inert.

**Not done, and on purpose: a refused press still keeps the pick.** The ask was
"treba da se auto iskljuci i kad failujes join". A refusal is pressing a sticker
— a slip of the hand — and the argument in `connectStep()`'s header still holds:
losing a standing pick to a mis-tap means pointing at the first card again. With
one-shot in, the stuck-mode complaint that made the refusal case feel urgent is
answered from the other end. Worth putting back in front of the same tester
rather than deciding twice.

<details>
<summary>The report as it stood</summary>

### Join stays armed, and that was the single loudest complaint

> "ne svidja mi se join jer je na toggle" ... "join pravi probleme" ... "treba
> da se auto iskljuci i kad failujes join" ... "i da ima custom cursor na join"
> ... "mnogo mi ide na kurac za ove stvari"

The one tool in the app that is a mode, and the first-contact reading of it was
that the mode is the problem. Three separate asks, and they are not the same
ask.

**It never disarms, and that is written down as the rule.** The header over
`connectStep()` in `ui/toolbar.ts` says it in as many words: staying armed after
a pair is what makes joining five things one trip to the toolbar, a press on
empty canvas is "not that one" rather than "stop", and Escape and the button are
the two ways down. So the behaviour is not a slip — it is a position, and the
tester spent an evening disagreeing with it.

**Correcting the chat, because it went the other way at the time.** It was said
in the conversation that arming with two cards selected puts the tool back down,
and the tester answered "ne desava se to". The tester is right. `connect` in
`commands/connections.ts` reads the selection at the moment of arming, sends two
or more straight to `joinAll()`, and arms **either way** — the comment there
ends "Armed either way, and that is the point of doing it here". Nothing in that
path disarms.

**A refused press keeps the pick, deliberately.** `connectTap()` turns down a
sticker with a toast and holds the standing pick, on the argument that a
mis-tap must cost nothing and losing the pick means pointing at the first card
again. The ask is for the opposite: a refusal ends the mode. Whichever way it
settles, it settles against that paragraph, not around it.

**The cursor already exists.** `.is-connecting` on the root sets
`cursor: crosshair` on `#viewport` and every `.item` (`canvas.css:1055`). So the
request is not for a missing cursor but for a *distinctive* one — crosshair is
the browser's most generic mode cursor and reads as no cursor at all. That is a
cheap change and the only one of the three that costs no argument.

Worth noting what this is evidence of: the mode is invisible enough that
somebody in it kept not knowing they were in it. Whether the answer is
one-shot-by-default, a louder armed state, or both, is the author's call — but
"press it again to stop" plus a generic crosshair was not enough signal for a
first-time hand.

</details>

### ~~The palette notification fires when it has nothing to say~~ — done

> "kad pobrisem sve slike iskoci dole notifikacija back to chosen pallet"

Deleting every image raises a "back to chosen palette" toast. The tester read it
as a non-sequitur, which it is from where they were standing: they deleted
pictures, and the app commented on colour. The behaviour was correct — the
palette really did revert because it was derived from the images — and the
sentence started in the wrong place.

**Traced and reworded.** `recolour()` in `ui/appearance.ts`, the `!hashes.length`
branch: it drops the derived pigments and reports through `failed()`, which
speaks even on the automatic path when the message differs from the last one —
which is why deleting the last picture is exactly the case that says it out
loud. That part is right and stays: the board's colour visibly changes, and a
colour change nobody explained is worse than one somebody did.

What changed is where the sentence begins. It read "No pictures left - back to
the chosen palette", which opens on a fact the app noticed. It now reads **"The
colours came from those pictures - back to your palette"**, which opens on the
thing the person just did and lets the colour follow from it — the actual causal
order, and the order the board changes in front of them.

Not touched: the two neighbouring messages in that branch and the `failed()`
de-duplication. Both were already saying the right thing in the right voice.

---

## Inconsistencies — each one reads as a bug even though none of them is

### Half the theme transitions and half of it snaps

> "neke stvari ti se gradually menjaju kad menjas temu a neke ne, samo to mi se
> ne svidja sto je inconsistant"

The complaint is precisely the inconsistency, not the speed. Whichever way it is
settled, it wants settling in one place. Not traced.

---

## Discovery — the first thirty seconds

### The starting board should contain one audio file

> "base layout kad tek udjes bi trebalo da ima jedan audio file jer ljudi ne
> znaju da to moze da se ubaci uopste"

The strongest item here. Audio is a whole capability that a first-time visitor
has no way to learn exists. One file on the starting board teaches it without a
word of copy.

### The playlist is empty on arrival

> "kad si u tom kao base delu i odes na playlist prazno je, bilo bi kul da ima
> nesto na pocetku odmah"

Same complaint, one screen further in, and the same fix would answer both.

---

## Features

### A wordmark for mbrd

> "daj neki logo ili nesto za mbrd jer ovako samo izgleda kao neki buzzword da
> se reloaduje" ... "kao reload ll1 cache type shit"
>
> "znam sta radi, samo kazem da mbrd treba da bude u fensi slovima da bi se
> videlo da je 'proizvod'"

Found on the update prompt. Set in the running text, "mbrd" reads as a technical
verb rather than as the name of the thing — the tester's first parse was that it
was offering to reload a cache. The point survives the joke: the name has to
look like a name.

### Colourblind mode

> "colorblind mode takodje uvek appreciated :D"

Worth reading next to `research/tier-palettes-2026-08-18.md`, which is already
about palettes and already has contrast rules in its amendments.

### Dark mode

Kosta's own, noted in the same conversation.

### Finish the timeline

> "ukljuci timeline to je isto kul, samo nedovrsen malo"

Liked; visibly unfinished. `timeline.ts` is 63 KB and already exists, so this is
finishing rather than starting, and "unfinished" was not pinned to anything
specific — worth getting them to point at what looked wrong before doing work.

---

## Not a request, but worth writing down

`trash.ts` landed well — "trash je kul asf" — and the far-lands bug was found
because the app is pleasant enough to mess about in. Both are the kind of thing
that does not show up in a defect list.

Four more, unprompted, all of them things nobody was asked about: the delete
animation ("mnogo mi se svidja delete animacija"), the whimsy dial ("bas je
kul", and the polaroids at *softish* got singled out), the board taking its
colours off three or more pictures — "YOOOOOOO VIDI STVARNO" — and the fact that
every right-click is the app's own menu rather than the browser's. The palette
one is worth reading beside the discovery items above: it is the feature that
*was* discovered without being explained, and it was discovered by dropping
files in, which is the same lesson as the audio file on the starting board.

And one second-hand judgement, from somebody who looked at it rather than used
it: "izgleda vibecoded asf". No detail behind it and no fix implied by it, but it
is the first-glance read of a stranger and it belongs next to the wordmark item —
both are the same complaint that the thing does not yet look like a product.
