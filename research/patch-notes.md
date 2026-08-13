# mbrd patch notes - the source

THE ONLY PLACE THE CHANGELOG IS WRITTEN. Two things are generated from this
file by `node tools/gen-patch-board.mjs`, and neither may be hand-edited:

  web/assets/patch-notes.mbrd   the board /patch opens - a real .mbrd, one
                                note card per release, read by the app through
                                the same unpackBoard() any dropped file goes
                                through
  web/patch.html                the page that serves it - the app shell, with
                                this prose inside <noscript> so a crawler and a
                                visitor with JavaScript off still get the words

The changelog is a board. That is not a metaphor here: /patch loads a .mbrd in
the Feed lens, with the normal menu button and the normal sidebar, and every
release is a card you can open. The static rendering exists because a board is
JavaScript and a search engine is not.

## Writing an entry

Newest first. One `##` heading per release, carrying the codename, then two
lines of metadata, then bullets:

    ## Both Hands
    version: 0.135 - 0.144
    date: 12 August 2026

    - [new] **What changed.** What it means for the person using it.
    - [fix] A repair, with no lead-in when the sentence is short.

`version:` is the number or the span the release covers, and the high end of
the newest one must equal VERSION in web/assets/js/version.js - the app prints
it in the foot of its sidebar, and a changelog behind the app it describes is
one that stops being believed. tests/patch.test.js holds the two together.

`date:` is `13 August 2026`, or `4 - 6 August 2026` where the release spans
days. From `git log -1 --format=%ad`.

A `###` heading divides a long release into named parts.

## The three tags

`[new]`, `[fix]` and `[faster]` lead a bullet, and there are only three on
purpose: a set that grows past what can be told apart at a glance is a legend,
and nobody reads a legend on a changelog. A bullet with no tag is prose about
the release as a whole.

## Tone

Written for somebody who uses the app and does not read the code. Say what is
different for them, not what was refactored. Short, concrete, calm. British
spelling, to match the rest of the app: colour, organise, centre.

Be honest about a release that has nothing in it for them. A run of internal
work gets a plain Maintenance section naming what it was and what it bought,
not a sentence dressed up to sound like a feature. There are several of those
below and they are the entries most worth trusting.

Separators are ` - `, a spaced hyphen. Never an em-dash: this whole repository
is em-dash-free on purpose. No emoji. `**bold**` around the thing a bullet is
about, `_word_` for the one accent-coloured word, backticks for a literal
string from the interface.

## Releases

## Under the Floor
version: 0.156 - 0.187
date: 13 August 2026

- **Almost nothing here is visible on a board**, and it would be dishonest to pretend otherwise. This is the release where the app was rewritten in a language that checks itself, taken apart into smaller pieces, and given a policy that limits what a page is allowed to do. What it buys you is fewer of the faults below arriving in the first place.
- [fix] **The app now tells you when something goes wrong.** A failure that used to end in a half-finished board and a message only the browser console ever saw now says what happened, on the board, in words.
- [fix] **Hovering works on a laptop that reports itself as a touchscreen.** Two-in-one machines say they have a finger even when a mouse is on them, and everything that appears when you point at it was staying hidden.
- [new] **This page.** The app now has a changelog written for the person using it, reachable from System - What changed. Nothing here is folded away or archived: the whole history is one column, oldest at the bottom.
- [fix] **The buttons round the edge of the board react to the pointer again in Chrome.** The menu button, the bin, the zoom pill and the panel close had all gone still on desktop Chrome, which reports itself as a touchscreen with no touchscreen attached. The menu button was the tell: its three bars changed colour and the button under them did not.
- [new] **The hint cards show on the Feed.** The three cards a brand-new board opens with had only ever been drawn on the canvas, so opening the app on a phone gave you an empty column and no suggestion of what to do with it.
- [fix] A card no longer takes the accent outline just for being pointed at - that mark means _selected_, and spending it on a hover left nothing to say which card you had actually chosen.

### Maintenance

- **Written in TypeScript and shipped as one file.** Ninety-odd source modules are compiled and bundled, so a board now downloads one script instead of fetching the whole tree - and a whole class of mistake is caught before it can ship.
- **A Content-Security-Policy, with a test that keeps it honest.** The page now declares exactly what it is allowed to load and where from, which is the difference between a bug being a bug and a bug being a way in.
- **The two largest files were split up** - the one that owned every board operation, and the one that styled every card - and a test now enforces the rule about which piece may reach for which. Continuous integration runs the suite, the types and the linter on every push.

## The Viewer
version: 0.145 - 0.155
date: 12 August 2026

- [new] **Open one thing as big as the window will allow.** Anything on the board can now be lifted off it and shown full size, with the board waiting behind - a photograph at its real resolution, a video with its own controls, a document you can read.
- [new] **Documents open properly:** Word, OpenDocument, slides, spreadsheets, CSV, SVG and comic archives. Not a download prompt and not a filename - the actual pages, read in the app.
- [new] **A PDF opens page by page**, so a long one starts reading immediately instead of after the whole file has been parsed.
- [new] **Markdown is set as prose**, on the card and in the viewer - headings, lists, quotes and links, rather than the asterisks you typed.
- [new] **A document shows the picture it already has of itself.** Most of these formats carry a preview image inside them, and using it means a card that looks like its contents without anything having to be rendered.
- [new] A dropped text file shows **its opening words** on the Feed instead of its name.
- [new] The Feed has a **right-click menu**, which it had gone without since it arrived.

## Both Hands
version: 0.135 - 0.144
date: 12 August 2026

- **The phone and the desk stopped pretending to be each other.** The two layouts had been one design with things hidden out of the smaller one; each is now placed on its own terms, and what the desk was missing was put there rather than copied across.
- [new] **Colour, Link and Stickers moved behind a More button on the phone**, so the toolbar holds what you reach for and not everything that exists.
- [new] **The Board tab was rebuilt** around one primary section and one fold, with a View row at the top that says which of the three faces of a board you are looking at.
- [fix] **The note composer drew its sheet at life size, off to the left** - writing a note meant aiming at a box that was not where it appeared to be.
- [fix] **The sticker drawer shuts the moment a shape is dragged out of it**, instead of staying open over the place you were dragging the shape to.
- [fix] **The Feed is printed on paper again.** It had been on untextured stock since it replaced the old strip, so the phone board was the one surface in the app with no tooth to it.
- [fix] The phone toolbar handle showed a square corner while pressed, and the Debug section was folded away so the System tab no longer ends on a footnote.

## Threads and Shapes
version: 0.130 - 0.134
date: 12 August 2026

- [new] **Draw a connection between two cards**, and edit it from a small chip that follows the line while it is selected. A board can now say that this relates to that.
- [new] **Stickers** - a drawer of shapes you can drag onto the board, each tintable from the board’s own palette rather than from a stock set of primaries.
- [new] **Hover flyouts on the toolbar**, so a tool with options shows them where the tool is instead of sending you to a menu to look for them.
- A full pass over the look of the app, with everything it found written down rather than quietly fixed - including which parts were deliberately left alone.

## Feed and Playlist
version: 0.126 - 0.129
date: 11 August 2026

- [new] **The Feed** - a board read as one scrolling column instead of a cramped canvas. It is a way to browse what is on a board, not a smaller version of the board.
- [new] **The Playlist**: every piece of audio on a board, as a player.
- [new] **More than one board.** A switcher that holds them all, each with a picture of itself, so a board is no longer the single thing this browser happens to be holding.

## Regions
version: 0.117 - 0.125
date: 4 - 6 August 2026

- [new] **Fences** - a named region drawn on the board rather than a card lying on it. Things inside one move with it, and its name is readable at any zoom, which is what makes a large board navigable.
- [new] **A colour picker**, so a pigment can be chosen by eye rather than picked from a list.
- At the softer end of the look, a region is now drawn as a **cork board**, with the stock to match.

## Grain and Credit
version: 0.105 - 0.116
date: 1 - 3 August 2026

- [new] **The paper got its tooth.** The sheet is a real 300gsm grain now, multiplied over the board and travelling with it as you pan and zoom, rather than a flat wash of colour.
- [new] **A now-playing bar** for whatever the board is playing, and a **credits sheet** for the two people who made this.
- [new] **The toolbar**, in the shape it still has.
- Maintenance: the single stylesheet the whole app had grown into was split into one file per subsystem, and the first full audit of the code was carried out and written down.

## Solid Ground
version: 0.87 - 0.92
date: 31 July 2026

- [fix] **A board with an unresolved conflict refuses to save** rather than writing something half-merged over the good copy, and three races behind that were closed with it.
- [faster] **Exporting no longer holds the whole board in memory twice.** The archive is written as it goes, which is the difference between a large board exporting and a large board failing to.
- [faster] Undo history is now bounded by **how much it is holding** rather than by how many steps it has, so a few very large steps can no longer fill the browser’s storage on their own.
- Maintenance: the file that owned every board operation was given a floor to stand on and had its layouts, geometry and stacking lifted out of it.

## Measured
version: 0.59 - 0.75
date: 28 - 31 July 2026

- [faster] **Panning and zooming a large board**, worked on against measurements rather than impressions - the reading taken against the display’s own refresh, and the numbers kept.
- [faster] **Photographs are mounted at a sensible size** for how large they are actually being drawn, and a video does not load until it is first played on a touch device. Zoomed out, image decoding and card shadows are shed entirely.
- [new] A redrawn app icon: three cards on the grid.

## Hardening
version: 0.41 - 0.57
date: 26 - 28 July 2026

- **The boundaries where a file comes in were tightened** - what is stored, what is imported and what is drawn - so that a malformed or hostile file is refused rather than trusted. The readers that parse files this app did not write check their sizes before they allocate.
- [fix] **Gestures snap to the board’s real grid**, not to the lattice as it appears at the current zoom - so a card dropped at 40% lands where one dropped at 100% would.
- Every bundled typeface now carries its provenance and its licence.

## First Light
version: 0.00 - 0.21
date: 25 July 2026

- **mbrd arrived.** An infinite freeform board in a browser tab, with no account, no server and nothing uploaded - and it was very nearly all built in a day.
- [new] **The whimsy axis**: one dial that takes the whole interface from scrapbook to spec sheet - the corners, the type, the ornament and how much anything moves - and the palettes that ride on it.
- [new] **Notes, links, audio cards, pictures and 3D models**, with album art filling a music card, a YouTube link that becomes a player if you ask it to, and Markdown in a note.
- [new] **A web of threads between items**, a bin that greys out when it is empty, renaming in place, and Find on the board with `Ctrl+K`.
- [new] **A board you can hold in one hand**, and the file format the whole thing saves to, specified and written down.

