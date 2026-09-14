# Clutter at phone width, and what could go

2026-09-14, against v0.340 on `localhost:6273`, Chromium at 390 × 844 CSS px,
Feed layout, Middle whimsy. The phone half of `old/ui-clutter-2026-08-15.md`,
which audited the desktop only (R18 in `rapid-fixes-2026-09-14.md`).

States driven: the empty board, a board of six photographs and a style tile
(top and scrolled), the Add drawer and its More menu, a tile's menu, all three
sidebar tabs, the masthead panel, Find, and the Playlist lens. The Timeline
strip is hidden at this width until it is turned on, so it is not in the list.

**Nothing below is cut yet.** The maintainer picks, then the cuts land.

---

## Cheap: controls that do nothing on a phone

These cost one `hidden:` or `when:` each, and nothing a phone user can reach
goes away.

- **P1. Keyboard hints on a touch menu.** A tile's menu prints `dbl-click`,
  `Ctrl C`, `F2` and `Del` beside its rows (`ui/menu.ts:615`, `:620`, `:695`,
  `:699`). A phone has no keyboard and no double-click. Cut: draw no `accel`
  when the menu opens with `{ mobile: true }`.
- **P2. A board action on the tile menu.** "Reload board" (`ui/menu.ts:690`)
  does nothing to the tile pressed. The maintainer decided on 2026-09-14 that
  the item menu keeps it on the canvas (the desktop audit's item D), so this
  asks only about the Feed: cut it under `{ mobile: true }`, where the tile
  menu is the only menu there is.
- **P3. Anchor on a Feed tile.** An anchor holds a card's place in a layout,
  and the Feed packs by order and ignores every place (`ui/menu.ts:516`).
  Cut: hide it under `{ mobile: true }`.
- **P4. Canvas settings on the Feed.** The Board tab shows Rearrange
  everything, Spacing and Snap to grid (`ui/settings-schema.ts:445`, `:448`,
  `:452`), and the Look tab shows Show grid, Show axes and Show readout
  (`:759`–`:763`). On the Feed none of the six changes anything: the wall has
  a fixed 10 px gap, no grid and no positions. Cut: a `when` that hides them
  while the Feed is the layout, or move them under the Canvas choice.
- **P5. A drop hint where nothing can be dropped.** The Look tab says "Drop a
  .woff2, .ttf or .otf on the board to add your own face". A phone cannot
  drop. Cut: on touch, say "Add one with Add → Files".

## Calls for the maintainer

Each of these is a design choice, not a removal.

- **P6. Two filled primaries on one tab.** The Board tab fills Save and Create
  tour, and the Feed toggle beside them, so three accent blocks compete on
  one screen. Choice: Create tour as a plain button, or no Tour section on the
  Feed. Unverified: whether a tour plays on the Feed at all.
- **P7. Nine controls for the title.** The masthead panel stacks Font, Weight,
  Font size, Font height, Line height, Vertical position, Italic, Wrap long
  names and Optical size over a Start over (`ui/mobile-header.ts`). "Font
  size" and "Font height" read as one thing. Choice: keep Font, Weight, Font
  size and Italic in view, and fold the rest behind an Advanced, as the
  sidebar folds its rare settings.
- **P8. Five full-width buttons in a column.** The System tab's "This browser"
  stacks Board contents, Timeline, Reload mbrd, Patch notes and Get the app
  (`ui/settings-schema.ts:967`–`:1019`), a screen of buttons. Choice: Reload
  mbrd and Patch notes behind the fold, or two to a row.
- **P9. Adding takes a second bar.** The foot holds the bin, Add, and undo
  with redo, in three containers. Add opens a second bar (Files, Note, More)
  above it, and More opens a menu (colour, link, stickers): two presses and a
  bar for a colour. Choice: one Add menu with all six rows, and no drawer bar.
- **P10. The title page is 39% of the first screen.** The masthead takes about
  330 of 844 px before the first card. Choice: cap it on a phone (for example
  at a quarter of the screen height), or keep it as the board's title page.
- **P11. The top buttons ride over the wall.** After a scroll, the menu and
  Find buttons float over the cards (the pen hides, as it should). Choice:
  hide them on a scroll down and show them on a scroll up, as a phone browser
  does its own bars, or keep them.

## A gap, not clutter

- **P12. The empty Playlist names a way back it does not show.** It says "Add
  a track, or switch back to the board", and nothing on that screen switches
  back. The way is the sidebar. Choice: a "Back to the board" button in the
  empty state.

## Recommendation

P1 to P5 first: each removes something that does nothing on a phone, and
none needs a decision. Of the rest, P7 and P9 buy the most room.
