# Where the clutter is, and what to cut

2026-08-15, against v0.201 on `localhost:6273`, desktop Chrome at 1063 × 718 CSS px.

Audited by driving the real app: resting board, sidebar (all three tabs, every
fold opened), a toolbar flyout, an item selected, the item context menu and its
`Edit` submenu, the canvas context menu, the timeline strip open, and the note
editor. **Not audited: anything below ~1000 px.** Chrome in this session refused
to resize the window under about 1000 px, so every claim here is a desktop
claim; `mobile.css` is 65 KB and deserves its own pass.

---

## The diagnosis

No single surface in mbrd is overloaded. Each one is individually argued and
individually defensible — the sidebar's fold discipline is genuinely good, the
toolbar is eight items, the zoom cluster is six. The app does not feel cluttered
because a panel is too full.

It feels cluttered for two reasons, and they compound:

1. **The same command is reachable from three or four surfaces at once**, under
   two or three different names. Nothing can be cut from any one surface,
   because each surface is justified in isolation. The union is what's heavy.
2. **The chrome is scattered into five floating clusters** in five positions
   with no shared anchor, so the eye has no primary and re-scans the whole
   viewport to find anything.

The structural rules in `CLAUDE.md` are what produced this, and they are not
wrong — they guarantee each surface stays internally coherent (one `cmds` entry,
one schema entry, one `FLYOUTS` entry). But **nothing in the ruleset bounds how
many surfaces one command may appear on**, so every new surface added a full
copy of the existing vocabulary. That's the missing rule.

---

## Findings, heaviest first

### A. Command duplication is the real weight

| command | where it lives | names it goes by |
| --- | --- | --- |
| `add-note` | toolbar, canvas menu, item menu, sidebar → Board → Add | "Note", "Add a note here", "Write a note" |
| `add-files` | toolbar, canvas menu, sidebar → Board → Add | "Files", "Add files" |
| `rearrange` | toolbar, canvas menu, sidebar → Board → Arrange | "Arrange", "Rearrange everything" |
| `find` | toolbar, canvas menu, Ctrl+K | "Find" |
| zoom to fit | zoom cluster, canvas menu, `F` | "Zoom to fit" |
| back to 0,0 | zoom cluster, canvas menu, `0` | "Back to 0,0" |
| show grid | sidebar → Look → Board & grid, canvas menu | "Show grid" |
| snap to grid | sidebar → Look → Arrange (advanced), canvas menu | "Snap to grid" |
| reload board | canvas menu **and** item menu | "Reload board" |

Four surfaces and two names for the single most common action in the app is the
clearest symptom. A user who learns "Note" on the toolbar meets "Add a note
here" on right-click and "Write a note" in the panel and has to work out they
are one thing.

**The rule to adopt:** every command gets exactly one *resting* home — a place
you can see it without doing anything. Everywhere else it may appear only as a
keyboard shortcut or a contextual repeat that acts on something the resting home
cannot reach ("here", at the cursor, is a legitimate reason to duplicate; "also
handy" is not).

Applied to the canvas right-click menu, which is currently twelve entries:

```
  drop  Add a note here     → toolbar (keep only if the "here" placement is real)
  drop  Add files           → toolbar
  drop  Find                → toolbar + Ctrl+K
  drop  Rearrange everything→ toolbar
  drop  Zoom to fit         → zoom cluster + F
  drop  Back to 0,0         → zoom cluster + 0
  keep  Select all
  keep  Filter by tag
  keep  Take the tour (2)
  keep  Snap to grid
  keep  Show grid
  keep  Reload board
```

Twelve to six, one edit in `ui/menu.ts`, and every dropped entry is still one
click or one key away. This is the cheapest large win on the list.

### B. The foot is over-subscribed

With the timeline open, one 1063 px row carries **26 controls in a 60 px band**,
in three separate containers:

```
[🗑] [↶ ↷]   [ Timeline  •—+—+—⊞—⊞—⊞—≡—⊞—⊞—⊞—⊞—⊞  34 of 34  🏷 ✕ ]   [− 100% + ⛶ ◈ 🔒]
 1     2                    ~55% of the width, still scrolling                6
```

The existence of `--foot-left` / `--foot-right` in `chrome.css` is the tell:
those tokens exist because three clusters were already fighting for one row.
The strip gets just over half the width and *still* needs a horizontal
scrollbar for its 34 events.

**Fix:** treat the timeline as a mode, not a widget. While it is open, collapse
the zoom cluster to the single `100%` chip and hide trash / undo / redo — all
three are keyboard-served and none of them is what you came to the timeline for.
The strip then gets the whole foot and stops scrolling at typical board sizes.

### C. The note format bar is five times wider than the note

Editing a note pops a floating bar measured at **706 px for a note about 130 px
wide**, with eleven controls, positioned above the note so it covers whatever
cards are behind it, and sitting flush against the right viewport edge.

```
[H1] H2  ¶ │ ≡ ≡ ≡ │ ▤ ▤ ▤ │ Serif │ A− A+
 ↑ red        ↑ red
```

Four separate problems in one bar:

- **Two red-filled pills active at once** (`H1` and align-left). The accent is
  the app's "this is the current state" signal and it is spent twice in 200 px.
- **Two near-identical icon triplets** — horizontal align and vertical align —
  which at 16 px read as the same glyph three times, twice.
- **Vertical alignment inside a note** is given equal billing to heading level,
  on a moodboard where notes are mostly one line.
- **"Serif"** is a word sitting among icons, a third visual language in one bar.

**Fix:** cut to what a moodboard note actually needs — `H1 H2 ¶`, horizontal
align, `A− A+`. Six controls, one accent. Vertical align and Serif move into
the item menu's `Edit` submenu, which already exists and is the right home for
set-once properties.

### D. The item menu carries board actions

Right-clicking a specific item offers **"Reload board"** and **"Add a note
here"**, neither of which touches the item you clicked. Both are already on the
canvas menu.

Also in that menu:

- **Three edit-ish verbs stacked** — `Open`, `Rename`, `Edit` — where `Edit`
  is a submenu of *picture* operations (Crop & adjust, Fill/Fit/No card, Extract
  palette). "Edit" is the one word in the menu that doesn't mean what it says.
  Rename it `Picture`.
- **"A tour stop"** is internal vocabulary in the user's menu. It's a toggle, so
  name it as one: `Include in tour`.

Twelve entries to nine, and the remaining nine all act on the thing clicked.

### E. Fill / Fit / No card shows two ticks at once

In `Edit ▸`, **"Fit in the card" and "No card" both carry checkmarks
simultaneously.** Fill / Fit / No card read as a mutually exclusive set but are
drawn as three independent checks, and two are lit.

Either the three are not actually exclusive and the grouping is misleading, or
the state is wrong. I could not tell which from the outside — worth a look at
the menu's state predicate before deciding whether this is a design fix (make it
a radio group with one tick) or a bug fix.

### F. The timeline strip is high ink, low information

Fourteen visible ticks drawn from three repeating glyphs (`+`, `⊞`, `≡`), no
dates, no labels, 34 events behind a scrollbar, and a `34 of 34` counter whose
two numbers are the same. You cannot tell one event from another, so the strip
occupies the entire foot and answers no question you'd ask it.

**Fix, cheapest first:** collapse runs the way a log does (`⊞ ×7`), and label
the axis with time rather than with icons. If the events genuinely aren't
distinguishable enough to label, the strip is the wrong shape for the data and
the inventory dialog is doing this job better already.

### G. Five clusters, five shapes

A resting empty board shows **18 controls in five separate rounded containers**:
menu button (top-left), toolbar of 8 (top-centre), trash (bottom-left), undo/redo
(bottom-left, a *second* pill 40 px away), zoom cluster of 6 plus a free-floating
scale bar (bottom-right).

Two easy consolidations that cost nothing:

- Trash and undo/redo are adjacent but split into 1 + 2. One pill of three.
- The scale bar floats free directly above the zoom cluster. It is a viewport
  readout and the zoom cluster is the viewport control — dock it.

Five containers to three.

### H. Idle drift undercuts the chrome

Twice during this audit the chrome faded out and the viewport drifted while I
was reading a menu, and a mouse move was needed to bring it back. Separate
concern, but it points the same way: an app that hides its chrome on idle is
already saying the chrome is too much to look at.

---

## Sequence

Ordered by payoff per unit of risk. Each is independent.

1. **Canvas menu 12 → 6** (finding A). One `MENUS` edit. Largest perceived
   reduction for the least code.
2. **Note bar 11 → 6** (C). Removes the worst single moment of clutter in the
   app.
3. **Foot collapses while the timeline is open** (B). Chrome-only change, no new
   surface.
4. **Item menu: drop the two board actions, rename `Edit` → `Picture` and
   "A tour stop" → "Include in tour"** (D).
5. **Investigate the double tick** (E) — decide bug or grouping.
6. **Consolidate trash + undo/redo, dock the scale bar** (G).
7. **Timeline strip legibility** (F). Biggest design question, least urgent.

## The rule worth adding

Item 1 solves today's duplication; it doesn't stop tomorrow's. The codebase
already enforces "one home per *kind* of thing" — one `cmds` entry, one schema
entry, one `FLYOUTS` entry. What it does not enforce is a ceiling on how many
surfaces a single command may rest on.

A test in the spirit of `tests/layers.test.js` would hold it: collect every
`data-cmd` in `index.html`, every `cmd:` in `ui/menu.ts`, and every `cmd:` in
`ui/settings-schema.ts`, and assert no command appears as a *resting* entry on
more than one, with a `DEBT` map of grandfathered exceptions that may only
shrink. That is the same shape as the layering test and the same discipline that
kept `@ts-nocheck` at zero.
