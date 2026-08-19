# Tier palettes: colour personalities for the whimsy ends

2026-08-18. Plan for finishing the work; the JS half is already done (see
"State of the work" below). Written to be carried out by an agent with no
memory of the conversation that produced it.

## AMENDMENTS — read first, they supersede the specs below

Added 2026-08-18, later the same day, after the first carry-out was measured;
A6–A8 added 2026-08-19. Design corrections from the user. Where a spec
below disagrees with these, these win, and a later amendment beats an earlier
one (A6 supersedes A5's role assignment; A7 narrows A4's 3:1 rule to
accent-as-text; A8 re-tunes A1-era pastel chroma); the superseded lines are
marked. The generated §3b blocks
in tokens.css were produced under the old transforms and need regenerating
under the new ones (no hand-tuning has been reported on them yet — if any has
happened by the time you read this, patch the affected tokens rather than
regenerating wholesale).

### A1 — Softish: no black anywhere

The near-black ink is the one thing left fighting the pastel: tier 0
currently keeps the table ink (L 0.268) with a ×1.4 dye — C ≈ 0.036, black
with a rumor of a tint. **The Softish ink becomes a deep, genuinely chromatic
version of the sheet hue** — dark plum on rose, deep pine on mint. The
scrapbook's felt-tip, not a laser printer.

- Replace `PASTEL_INK_DYE` (×1.4) with a real ink treatment. Starting
  numbers, tunable: `--ink` L + 0.035 (≈ 0.30 — below that the chroma is
  perceptually swallowed), C = clamp(C × 2.8, 0.06, 0.095); `--ink-2` and
  `--ink-3` keep their L ladder, same chroma rule. Hue is already
  `roles.sheet` — no role change.
- `--accent-fg` follows for free (it is `vars['--ink']` in JS and
  `var(--ink)` in the generated CSS).
- The rules/hairlines already take the ×2.6 paper dye; if they still read
  grey beside the new ink, pull them toward it in tuning rather than
  pre-deciding here.
- Expected, not a bug: a pastel-yellow board's deep ink is physically
  olive/sepia — the gamut holds no dark vivid yellow. `hex()` clips
  gracefully and sepia-on-cream is a fine scrapbook answer.
- Harsh keeps its near-black: that tier is the black-ink poster and the user
  named Softish only.
- Apply in: `temper()`'s ink path, the generator's tier-0 ink rule,
  regenerated §3b tier-0 blocks, the lab mirror.

### A2 — Harsh: the wall is not enough, go to the cusp

Measured on the first carry-out: the generated tier-2 quartets are visual
no-ops for every preset — Papyrus accent `#b94900` → `#ba4900`, warm
`#e89100` → `#e89100`, Orca `#008379` → `#008379`. The presets already sit
at the sRGB wall at their lightness ("the presets all ask for 0.185 and what
differs is how much of it their hue can hold" — the PIGMENT table's own
comment), so pushing chroma at fixed L returns the colour unchanged.

**The bold lever is lightness: `bolden()` moves L to the hue's cusp** — the
lightness at which that hue holds its maximum chroma — then asks for
`BOLD_C` and lets `hex()` clip. Chartreuse cusps near L 0.85+, crimson near
0.55–0.63, teal near 0.70, violet near 0.47. That is how a green becomes
acid `#C2FE0C` instead of the current mud.

- `bolden()` becomes hue-aware (it needs `h` to find the cusp — thread it
  through `dressFor`/`build`, which know the role hues). Cusp by search:
  sample L over ~[0.35, 0.95], take the L with the largest in-gamut chroma
  using the same bisection `hex()` already does. 72 hue bins make caching
  trivial if it matters, which it likely does not.
- Keep the pull as a constant (`BOLD_CUSP_PULL = 1` to start) so tuning can
  back it off the full Marathon commitment.
- **`repair()` must not darken the accent at tier 2** — the existing loop
  would walk a cusp-light acid back down to reach 4.5:1 under a white label,
  un-cusping it, the same self-overruling bug tier 0 already guards. Same
  fix as tier 0: skip the loop, set `--accent-fg` to the better of the light
  mix and the ink. Black-on-acid is the reference look (see A3 sources).
- Generator tier-2 rule changes identically; its `--accent-fg` contrast
  check already handles the label flip and will now emit `var(--ink)` for
  the light-cusp hues.

### A3 — Harsh: the two loud voices take opposite registers

Marathon's palette is exactly five values: acid `#C2FE0C` (OKLCH ≈ L 0.92,
C 0.24, h 127 — chartreuse *at its cusp*), blurple `#5200FF` (≈ L 0.47,
C 0.31, h 277 — violet at *its* cusp, which is dark), black, white, grey.
Not "two saturated colours": two hues each at their own cusp, which lands
them at **opposite ends of the lightness scale** — one shouts, one carries
the depth, the achromatics do the typography.

mbrd already has the two-voice structure: `--accent` and `--leafy`. At
tier 2:

- The accent goes to its cusp (A2).
- The second voice goes vivid in the **opposite register**: if the dressed
  accent landed light (L ≥ ~0.65), `--leafy` is worn deep-and-vivid
  (L ≈ 0.45–0.50 at the wall — the blurple register); if the accent cusped
  dark, the leafy takes the light register (L ≈ 0.80 at the wall).
- The file's own law stands: no colour is constructed. The register rule
  dresses whatever second hue the board/preset actually has; a one-hue board
  gets one cusp voice and that is honest.
- `--accent-deep` stays the darker twin — pressed states need kinship, not a
  second hue. `--accent-warm` cusps like the accent.
- Same rule in the generator for the presets' leafy; regenerate tier-2
  blocks.

Sources: colorpickercode.com/color-palette/brand-palettes/marathon/ and
abduzeedo.com/marathon-brand-identity-kurppa-hosk (identity by Kurppa Hosk).

### A4 — Harsh: the registers anchor to the sheet, not to the accent

Found on the first carry-out of A2/A3: a light-cusp accent (chartreuse at
L 0.92) on the near-white sheet has no contrast with its own ground - the
button vanishes, and every text-level use of `--accent` is illegible. This is
also faithful to the reference the wrong way round: on Marathon's *white*
layouts the acid is big bounded fields and the UI is black and blurple; acid
carries the interface only on the black ground.

So A3's register rule stands, but anchored to the ground:

- **The accent takes the register opposite the sheet.** On Harsh's
  near-white paper that means the dark-vivid register: start at the cusp and
  descend the gamut wall - recomputing wall chroma at each L step, so it
  stays as vivid as the hue allows on the way down - until
  `contrast(--accent, --paper) >= 3` (WCAG component contrast). Hues that
  cusp dark (crimson, violet, teal) barely move; chartreuse lands around
  L 0.60-0.66, a loud poster green rather than acid.
- **The light cusp moves to the non-text roles.** `--leafy` and
  `--accent-warm` take the light register - washes, chips, and Harsh's
  `--highlight`, which is already a solid block of the warm family. That is
  where acid-on-white lives in the reference: bounded fields, never text.
- This corrects A2's repair note: the accent loop at tier 2 comes *back*,
  but it walks the wall toward the 3:1 sheet floor rather than the 4.5:1
  label floor. The label logic is unchanged - better of light mix and ink,
  and ink wins under any accent light enough to need it.
- Dark mode inherits the rule for free: the anchor is ground polarity, so on
  the future dark sheet the registers swap and the light cusp finally
  carries the buttons - the Marathon black poster. Nothing here needs
  re-deciding then.
- Optional CSS garnish, cheap and very poster: Harsh buttons bounded in
  `var(--ink)` (the tier already draws item edges as ink hairlines). It
  cannot substitute for the contrast floor - borders save a button, not a
  link - but it sharpens the look either way.
- Apply in: `bolden()`/`build()` (accent register + descent), generator
  tier-2 rule, regenerate tier-2 §3b blocks, lab mirror. The JS path matters
  as much as the CSS one: Dynamic runs through the same `bolden()`, and the
  user saw extracted palettes wash out exactly like the presets.
- Acceptance check, from the user's own report: at Harsh, **absinthe**,
  **orca**, and a **Dynamic extraction from a green- or teal-heavy board**
  must all print accents that clear 3:1 against the sheet. Those are the
  observed failures - olive-chartreuse and teal both cusp near L 0.85-0.90
  and vanished into the paper. Tearose is the control: crimson cusps dark
  and should look unchanged by A4.

### A5 — Harsh: the dominant hue gets a loud role too

Observed on a real board (five cobalt Nous posters + one Marathon shot at
Harsh, Dynamic): the interface came out entirely green. Not a bug in the
vote - the blue won it, became the sheet, and rolesFor() handed the loud
accent role to the counter-colour, exactly as designed. The hole is at
Harsh: the near-white paper and near-black ink *erase the sheet family*, so
the dominant colour of the board - five images out of six - is represented
by nothing, and the minority colour owns the screen. (The observed flip to
all-blue on adding a sixth image is the green dropping under MIN_SHARE -
membership working as designed, listed here so nobody chases it as a bug.)

The fix is the completion of A3, with the register pair drawn from the
right two hues:

- **At tier 2 the two loud voices are the accent and the dominant (sheet)
  hue** - not the accent and the third hue. The dominant hue takes the deep
  register: worn dark-and-vivid at the wall (L ≈ 0.45-0.50), it becomes the
  second voice (`--leafy`'s slot). On the observed board that is cobalt worn
  deep beside the acid - blue and green both present, which is what the user
  asked for by name. A genuine third hue moves to the washes; a single-hue
  board is unchanged (accent == sheet, one voice, A4 applies).
- **Bounded complementary nudge, opt-in by the numbers:** rotate the deep
  voice's hue toward the *accent's complement* by at most
  `COMPLEMENT_TURN ≈ 25°`, with the same signed-shortest-way math as
  `warmer()`. The user has approved this tweak explicitly. It is a nudge to
  a hue the board already holds, never an invented colour - the file's law
  survives. On the observed board: chartreuse ~127° has its complement at
  ~307°, so cobalt 262° turns to ~287° - toward blurple, which is the
  Marathon pairing arrived at from the board's own pigments.
- Applies to the extraction path (roles carry the sheet hue) and to the
  generator for any preset whose sheet hue stands apart from its accent;
  presets that are analogous throughout (most of them) keep A3's
  leafy-as-second-voice reading.
- Only tier 2. Middle and Softish keep the sheet family on actual sheet
  duty, where it is visible because the paper is allowed to be tinted.

### A6 — Harsh: the winner takes the accent (supersedes A5's role split)

The user's direct call, asked and confirmed scope: **at Harsh only, the hue
that won the vote becomes the accent.** A5 kept the counter-colour in the
accent seat and gave the winner a consolation deep role; A6 swaps the seats.
The register machinery of A4 and the nudge of A5 both survive - only the
occupants change.

- **At tier 2, extraction path:** the dominant hue (what `rolesFor()` calls
  the sheet family) takes `--accent`. Per A4 it is worn at the register
  opposite the near-white sheet - deep at the wall, clearing 3:1 - so the
  observed board leads with cobalt, not acid.
- **The counter-colour becomes the second voice** in `--leafy`'s slot, at
  the other register (the light cusp - which suits the acids and teals that
  live there, and A4 already keeps that register out of text roles).
- **The complementary nudge now turns the second voice**, ≤
  `COMPLEMENT_TURN ≈ 25°` toward the accent's complement, same
  signed-shortest-way math. Observed board: accent cobalt 262° has its
  complement at ~82°; chartreuse 127° turns to ~102° - still acid, now
  tuned to the blue it sits beside.
- **A single-hue board is unchanged** (winner == only hue, one voice, A4
  applies). **`paletteFromAccent` is unchanged** - a hand-picked colour was
  never a vote, the pick stands as the accent at every tier.
- **Presets are unchanged by A6** - a preset has no vote and its accent is
  authored; the generator keeps A5's reading for any preset whose sheet hue
  stands apart from its accent.
- **Only tier 2.** Middle keeps the counter-colour accent and tinted paper
  exactly as it renders today - the user confirmed this scope explicitly.

### A7 — Harsh: the accent splits by role — fills wear the cusp, text wears the wall

Observed (single Marathon image, Harsh, Dynamic): the Save button came out
olive, and the user asked where the acid went. The answer is A4 working as
written: "descend the wall until 3:1 against the sheet" took chartreuse from
its cusp near L 0.9 down to L ≈ 0.62, and dimmed chartreuse is olive. The
rule is right for *text* - the BOARD tab label needs that darkness - and
wrong for *fills*: a button's legibility comes from its label and its edge,
not from the fill against the paper. Marathon itself never sets acid type on
white; acid appears as fills carrying black type. So at tier 2 the accent
stops being one colour:

- **`--accent` keeps the cusp** - the true acid, for fills: buttons,
  swatches, chips, selection. `--accent-fg` resolves to the ink whenever the
  accent sits in the light register (A4's contrast test already decides
  this), and the ink border A4 offered as optional garnish becomes
  **required** on Harsh buttons, so a pale fill still reads as a control on
  white paper.
- **A new token `--accent-text` carries the wall-descended form** (the
  olive) for accent-as-text and thin strokes: tab labels, links,
  underlines, focus rings. It is the same pigment at its legible lightness
  - the two-register idea applied inside the accent itself.
- **Default it to the accent:** `--accent-text: var(--accent)` once in the
  base `:root`; only tier-2 blocks (hand block, §3b combos, and `dressFor(2)`
  in JS) override it. Tiers 0 and 1 then render bit-identically with zero
  edits to their blocks - the tier-1 lock holds by construction.
- **Consumer audit, the real work:** every `var(--accent)` in the cascade
  that renders text or a thin stroke moves to `var(--accent-text)`. Fills
  stay. `--accent-deep` already covers some dark-on-light duty and keeps its
  twin role (A3) - do not merge it with `--accent-text`; deep is a fixed
  darker twin (L ≈ 0.415), text is "as light as still clears 3:1".
- **Dark-accented palettes are unaffected in effect:** where the accent's
  cusp already clears 3:1 (tearose's crimson), both forms compute to the
  same colour. The split only *shows* on light-cusp hues - acid, teal,
  amber.
- **Test traps, deliberate edits:** the palette-block parity check in
  `tests/appearance.test.js` currently allows exactly `['--accent-fg']` as
  the extra beyond the block list - `--accent-text` joins that allow-list.
  If `--accent-text` is set per tier-2 palette block it must follow the
  whimsy-attribute-first selector convention to stay visible to the same
  regex. AXIS vs PALETTE token ownership in `appearance.ts` needs
  `--accent-text` filed on the palette side (it is derived per palette, like
  `--accent-fg`).
- **Only tier 2 emits a distinct value.** The token exists at every tier
  (as the alias) so no selector ever falls back to an unset var.

### A8 — Softish: give some saturation back

User verdict on the current tier 0: "too far gone." The chalk wash drains
more chroma than the look needs. Keep the pastel *lightness* (PASTEL_L,
PASTEL_PULL stay) - the complaint is saturation, not brightness. Raise the
chroma of the wash:

- `PASTEL_C_SCALE` 0.6 → **0.75**
- `PASTEL_C_MAX` 0.10 → **0.13**
- `PASTEL_C_MIN` 0.055 → **0.065**

The A1 ink is separately tuned (PASTEL_INK_*) and is not the complaint -
leave it unless the richer pigments now make it look drab beside them, in
which case nudge `PASTEL_INK_C_MAX` toward 0.11 and stop there. Regenerate
the §3b tier-0 blocks from the new numbers (same caveat as always: patch,
don't regenerate, any token the user has hand-tuned by then). These numbers
are a starting point for the user to tune live - err on the saturated side
of them rather than under.

## The decision

The three whimsy tiers stop being one palette in three shapes. Each end gets a
colour personality of its own:

- **Softish (0)** — pastel. The sheet takes more dye on slightly deeper paper;
  every pigment is pulled toward chalk (high L, drained and capped C). Buttons
  carry a dark label by design, not by fallback.
- **Middle (1)** — untouched. **The user likes it as it is.** It is the
  reference the ends are relative to, and no edit in this plan may change what
  tier 1 renders, in JS or CSS.
- **Harsh (2)** — bold, Marathon-poster mode: the existing near-white sheet is
  kept (it was already the `plain` treatment), ink drops to near-black,
  hairlines harden, and every pigment goes to its hue's *cusp* at wall
  chroma, with the two loud voices in opposite lightness registers — see
  amendments A2 and A3 for why "chroma 0.40 at table lightness" was not
  enough.

Scope is **everything**: extracted and hand-picked palettes (JS, done) *and*
the default look plus the named presets (CSS, this plan).

Decision record, for later work:

- The Harsh *ground* question (stark white vs dark) was resolved by deferring
  it to the planned dark-mode project: whimsy owns boldness, the theme will
  own ground polarity. Harsh + light = white/neon; Harsh + dark = deep
  pigmented ground. **The dark ground uses no black anywhere** — the sheet is
  the board's own hue worn deep at real chroma (seed numbers: paper
  L 0.205 / C 0.048 in the board's hue, ink a warm off-white L 0.93 / C 0.02
  of the same hue, accent label chosen between sheet and ink, never a
  black/white literal). Reference bench with all treatments computed:
  https://claude.ai/code/artifact/082377f8-53a8-4bee-85c1-f04f95d74a7d
- The generated CSS numbers are a **starting point the user will hand-tune**.
  The generator is therefore a one-shot printer (output pasted once), not a
  build step that would overwrite tuning.

## State of the work

Done, tested (`node --test tests/pigments.test.js` — 41 pass):

- `web/assets/js/ui/pigments.ts` — `Traits.plain` replaced by
  `tier?: number`; new constants block ("The ends of the axis, as what each
  does to a pigment"): `PASTEL_*`, `BOLD_C`, `BOLD_L_MIN`, `BOLD_SHEET`;
  exported transforms `pastel()` and `bolden()`; `temper()` dresses the sheet
  per tier (bold = old `plain` papers + fixed `BOLD_SHEET` inks/rules; soft =
  `PASTEL_DYE`/`PASTEL_INK_DYE`/`PASTEL_PAPER_DROP`); `build()` dresses
  pigments via `dressFor(tier)` after measurement and dials; `--accent-deep`
  is derived from the *dressed* accent (stays the darker twin); `repair()`
  takes `tier` and at tier 0 skips the accent-darkening loop, setting
  `--accent-fg` to the better of ink and light mix; `paletteFromAccent` and
  `extractPalette` take `{ tier = 1 }` — **the pick still stands as
  `--accent` at every tier**.
- `web/assets/js/ui/appearance.ts` — the three call sites pass
  `{ tier: current.whimsy }` (was `{ plain: current.whimsy === HARSH }`).
  `reshade()` already re-derives on every slider move, so no new machinery.
- `web/lab.html` — the drift check passes `{ tier: plain ? 2 : 1 }`.
- `tests/pigments.test.js` — the two `plain: true` call sites are `tier: 2`.

Not committed. Nothing below is started.

## Remaining work

### 1. `tools/gen-tier-palettes.mjs` — the one-shot generator

A printer in the mould of `tools/preset-oklch.mjs` (which it should sit
beside and crib from): reads `tokens.css`, prints CSS to stdout, writes
nothing. Header comment must say the output is pasted into tokens.css §3b
once and tuned by hand from there — rerunning it later would overwrite tuning
and must stay a deliberate act.

Inputs: the literal pigment hexes of the base `:root` block (the default
look, Papyrus) and each `:root[data-palette="…"]` block —
`preset-oklch.mjs` lines 18–21 shows exactly how to slice them. Convert via
`oklch()` imported from `../web/assets/js/ui/pigments.ts` (Node 22.18 strips
types; the existing tool already does this import).

Transforms — import `pastel`, `bolden`, `hex`, `contrast` from pigments.ts so
the CSS starting point cannot drift from the JS:

- **Tier 0, full `PALETTE_TOKENS` set per look:**
  - papers (`--paper`, `-2`, `-3`, `-card`, `--rule`, `--rule-2`): keep each
    literal's own hue, `C × 2.6`, `L − 0.008` (mirror `PASTEL_DYE` /
    `PASTEL_PAPER_DROP` — read them from pigments.ts rather than restating if
    exporting them is cleaner).
  - inks (`--ink`, `-2`, `-3`): ~~own hue, `C × 1.4` (`PASTEL_INK_DYE`)~~
    **superseded by A1** — the deep chromatic ink treatment.
  - `--accent`, `--accent-warm`, `--leafy`: `pastel()` of the literal, at its
    own hue.
  - `--accent-deep`: the twin rule, preserving each palette's own drop —
    `L = accent′.L − (accent.L − deep.L)`, `C = accent′.C × (deep.C / accent.C)`,
    at the deep's own hue.
  - `--accent-fg: var(--ink)` (resolves to the tier-0 ink; a literal would
    not follow tuning).
- **Tier 2, quartet + label per look:** `bolden()` of accent/warm/leafy at
  their own hues — **as amended by A2 (cusp lightness) and A3 (opposite
  registers for accent and leafy)**, not the original fixed-L wall push,
  which is a measured no-op for every preset; deep by the same twin rule from
  the boldened accent; `--accent-fg` only when white fails —
  `contrast(accent′, '#ffffff') >= 4.5` → omit (the hand Harsh block's
  `#fff` stands), else emit `--accent-fg: var(--ink)`. **No sheet tokens at
  tier 2**: the hand `[data-whimsy="2"]` block already derives paper and ink
  from `var(--accent)` by color-mix, so the boldened accent propagates
  through its whole ramp for free — emitting sheet literals would kill that
  live derivation.

Selectors, in this exact shape (order matters — see traps):

```
:root[data-whimsy="0"] { … }                            /* default look */
:root[data-whimsy="0"][data-palette="absinthe"] { … }
:root[data-whimsy="0"][data-palette="tearose"] { … }
:root[data-whimsy="0"][data-palette="orca"] { … }
:root[data-whimsy="2"] { … }
:root[data-whimsy="2"][data-palette="…"] { … }
```

Literals only — **no `color-mix()` in generated blocks** except the two
`var(--ink)` label references. Mixes would need companions in the
`@supports not` legacy section (§7) and drag `tests/legacy-color.test.js`
into this; literals need nothing.

### 2. `tokens.css` — paste and re-argue

- Paste the generated section as **§3b**, immediately after the
  `[data-whimsy]` blocks and **before** the quality section and before the
  `@supports not (color: color-mix(…))` legacy block —
  `tests/appearance.test.js` cuts the file at that `@supports` line
  (`lookTokens()`), and the combos must be inside the scanned half. Give it
  a section comment: generated once by `tools/gen-tier-palettes.mjs`,
  hand-tuned since, rerun only to start over.
- **Rewrite the §3 header paragraph** that begins "What the axis does NOT
  touch is the palette." It is now false at the ends and true in the middle,
  and the file's convention is that prose argues the code next to it. Say:
  the middle is the base and never moves; each end dresses the pigments
  (§3b, and the dressing rules live in pigments.ts); Harsh's own block still
  derives its sheet from the accent, which is how the bold quartet reaches
  its paper and ink.
- Amend the Softish block's opening comment ("Shape, motion, ornament and
  reactivity only. No pigment…") the same way, and add
  tier-0's `--accent-fg` story there or in §3b (the middle's label logic
  does not survive a pastel accent).
- Cascade facts the section comment should state, because they are the whole
  mechanism: bare `:root[data-whimsy="n"]` is (0,2,0) and sits *after* the
  `[data-palette]` blocks, so it outranks them by order — which is why every
  named palette must have a (0,3,0) combo block, and why a future palette
  added without regenerating gets the *default's* pastel at tier 0. The
  drift test in §3 below is what turns that from a silent wrong into a red
  test.

### 3. Tests

- `tests/appearance.test.js` — add a combo-parity test:
  - Collect palette ids from the existing `PALETTE_BLOCKS` regex; collect
    combo blocks with
    `/:root\[data-whimsy="([02])"\]\[data-palette="([a-z0-9-]+)"\]\s*\{([\s\S]*?)\n\}/g`
    over `lookTokens()` with comments stripped (reuse the `declaredIn`
    stripping).
  - Assert every palette id has a combo at both tiers ("regenerate with
    tools/gen-tier-palettes.mjs" in the message), and every token any combo
    declares is in `PALETTE_TOKENS`.
  - Verify (it is true today, assert nothing that breaks it): combined
    selectors match **neither** `WHIMSY_BLOCKS` (requires `"\d"]` then `{`)
    nor `PALETTE_BLOCKS` (requires `:root[data-palette` first) — so the two
    existing parity tests are blind to §3b by construction. The bare
    generated tier blocks *do* match `WHIMSY_BLOCKS`, and their tokens are
    all `PALETTE_TOKENS`, which the owns-test subtracts. No change to those
    tests should be needed; if one fails, the selector shape drifted from
    this plan.
- `tests/pigments.test.js` — add:
  - Ends dress, middle stands: at a hue with gamut headroom
    (**use h 145, not 200** — at L 0.55 a blue-cyan's wall is below the
    middle's own 0.147, so bold and middle clip to the same hex and a
    chroma comparison at 200 fails), `chromaOf(tier2 accent) >
    chromaOf(middle accent)`; `lightOf(tier0 accent) > lightOf(middle)` and
    `chromaOf(tier0) < chromaOf(middle)`; `paletteFor([h], { tier: 1 })`
    deep-equals `paletteFor([h])`.
  - The pick stands at all three tiers:
    `paletteFromAccent('#3355ff', { tier })['--accent'] === '#3355ff'`.
  - A pastel accent keeps its lightness and carries the ink as its label:
    tier-0 `--accent-fg === --ink`, `lightOf(--accent) > 0.7`.
- Run the whole suite, not just these two files — `tests/appearance.test.js`
  greps `appearance.ts` source text and `tests/layers.test.js` et al. read
  structure.

### 4. `web/lab.html` — the pigment lab has drifted

The lab carries an inline copy of `temper()`/`build()` (its `P.plainPaper`,
`P.plainTint` dials, `build(roles, traits, isPlain)`) that still models
Harsh as paper-whitening only. Its drift box compares the inline model
against the real `extractPalette(chunks, { tier: plain ? 2 : 1 })` and will
now report drift whenever the plain checkbox is on. Mirror the dressing into
the inline model (`pastel`/`bolden` are exported for exactly this kind of
reuse), and preferably replace the "plain end" checkbox with a three-stop
tier control so Softish is tunable on the bench too — the lab is where the
user will do the tuning this plan exists to enable. The `WHIMSY` preview
strip near line 787 (`plain: false/false/true` per level) wants the same
tier treatment.

### 5. Wrap-up

- `npm test` (all), `npm run lint`, `npm run typecheck`, `npm run build`
  (the committed bundles `web/assets/app.js` and `web/assets/lab-pigments.js`
  must not drift behind pigments.ts).
- Launch the app and slide the axis on: the default look, each named
  palette, an extracted board, a hand-picked accent. Middle must be
  pixel-identical to before.
- Report: **no `.mbrd` schema change** (whimsy and vars already travel), no
  service-worker or generated-catalogue change. Boards saved before this
  change wear their stored (middle-style) vars until the slider or the
  extraction next runs — that is the existing re-derive-on-move behaviour,
  not a regression.

## Traps, all found by reading — do not rediscover them

- `WHIMSY` must stay three stops: the anti-flash guard test in
  appearance.test.js pins `/^[0-2]$/` against `WHIMSY.length`.
- `recolourFromBoard(` must appear exactly 4 times in appearance.ts source
  (same test file).
- The palette-parity test asserts the tokens `PALETTE_TOKENS` carries that no
  pure `[data-palette]` block sets is exactly `['--accent-fg']`. Combo
  selectors must therefore be written **whimsy-attribute first** so they
  cannot match `PALETTE_BLOCKS`; write `--accent-fg` in combos freely, they
  are invisible to that test.
- `erasableSyntaxOnly`: no enums/namespaces in anything the tests import —
  the tier is a plain `number`, keep it that way.
- Middle is locked. Every transform must be identity at tier 1/undefined,
  and the generated CSS declares nothing at tier 1.
