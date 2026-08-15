# mbrd patch notes - the source

THE ONLY PLACE THE CHANGELOG IS WRITTEN. One thing is generated from this file
by `node tools/gen-patch-page.mjs`, and it may not be hand-edited:

  web/patch.html   the whole changelog as a document, inside the app itself

/patch *is* the app: the page is index.html's entire body, so the bundle boots
and the sidebar over the changelog is the real one - the real tabs, the real
sections, built from the real schema. What it is not is a board. The session is
never read and never written, the preference writer is frozen, and every control
that would act on a board a reader has not got is shown and greyed rather than
hidden. It is dressed by the app's own stylesheets, which means it follows the
whimsy dial: the changelog arrives printed the way that reader's own board is
printed, from scrapbook at one end of the axis to spec sheet at the other.

## Writing an entry

Newest first. One `##` heading per release, carrying the codename, then two
lines of metadata, then bullets:

    ## Both Hands
    version: 0.135 - 0.144
    date: 12 August 2026

    - [new] **What changed.** What it means for the person using it.
    - [fix] A repair, with no lead-in when the sentence is short.
    - [faster] A bullet may wrap: an indented line continues the one above
      it, folded with a single space. The wrap is a property of this file and
      not of the sentence, and the page picks its own line breaks from the
      width it is being read at.

`version:` is the number or the span the release covers, and the high end of
the newest one must equal VERSION in web/assets/js/version.js - the app prints
it in the foot of its sidebar, and a changelog behind the app it describes is
one that stops being believed. tests/patch.test.js holds the two together.

The spans are contiguous and they cover everything. Every commit from the first
to the current one falls inside exactly one release, which is the property that
makes a gap in the record visible instead of plausible. This was not true until
v0.195: four runs of commits - 0.22 to 0.40, 0.76 to 0.86, 0.93 to 0.104 and
0.152 to 0.155 - fell between two spans and were described by neither, while
several of the things done in them had been quietly folded into the bullets of a
release whose number did not contain them. When a new release is written, the
one below it ends at the number below its own.

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
spelling, to match the rest of the app: colour, organise, centre. The one place
American spelling is allowed is inside backticks, where a label is being quoted
as it appears on screen - the button really does say `Optimize`.

Be honest about a release that has nothing in it for them. A run of internal
work gets a plain Maintenance section naming what it was and what it bought,
not a sentence dressed up to sound like a feature. There are several of those
below and they are the entries most worth trusting.

Separators are ` - `, a spaced hyphen. Never an em-dash: this whole repository
is em-dash-free on purpose. No emoji. `**bold**` around the thing a bullet is
about, `_word_` for the one accent-coloured word, backticks for a literal
string from the interface.

## Releases

## Every Step
version: 0.198 - 0.201
date: 14 August 2026

- [new] **The Timeline, under System, is every change to the board as a step you
  can go back to.**
- [new] **The Timeline lives in the board file rather than in the tab**, so it is
  still there tomorrow.
- [new] **A step can be given a name**, and a named step is a landmark you can
  find again months later.
- [new] **An align, a distribute or an arrange can be changed after the fact**,
  and everything you did after it happens again on top of the new answer.
- [new] **Exporting asks whether to send the history with the board**, and the
  answer already under your thumb is to leave it out.
- [new] **The Timeline offers to fold steps older than thirty days into the
  starting point**, leaving the board _unchanged_ and the named landmarks where
  they are.
- [new] **`Board contents` takes you to the card**, so pressing a row in the list
  of heaviest files travels the board to whatever is using it.
- [new] **The board file names its own parts**, so a `.mbrd` renamed to `.zip`
  opens with the pictures under the names of the cards they sit on.
- [new] The palette menu draws each palette as a bar of its own colours down the
  trailing edge, where they line up and can be read against each other.
- [fix] **Hovering a card animates again**, after several releases of the lift,
  the tilt and the ring arriving instantly.
- [fix] **A second press on a menu button closes the menu** rather than reopening
  it.
- [fix] **A note no longer sticks to the pointer after you change its face.**
- [fix] The panel row that reports how much undo is left is called `How much can
  be undone` rather than `Undo history`.
- [faster] **A board carrying an embedded typeface saves quicker**, now that
  faces are stored as they are rather than compressed into a copy that was never
  any smaller.
- The three lines on an empty board now say what the board is for rather than
  listing what you are allowed to drop on it.

## Second Thoughts
version: 0.197 - 0.197
date: 14 August 2026

- [new] **The board remembers what it used to look like**, keeping copies as you
  work and any you name yourself under System, then `Earlier versions`.
- [new] **`What is in this board` says where the weight went**, counting by kind
  and naming the ten heaviest files and anything stored that no card uses any
  more.
- [new] **A style tile joins the two ways of saving a picture**, carrying the
  palette, the faces, a few of the pictures, the name and the date.
- [new] **A cut-out picture can drop its card**, landing on the board as the
  shape rather than in a box.
- [fix] **The Join tool no longer accepts a join it cannot draw**, and boards
  already carrying one have it cleaned out when they open.
- [fix] The `Arrange` panel no longer hangs off the end of the toolbar.
- [fix] The sticker pad opens at the top rather than a few pixels down, so the
  first heading is not sliced along the letters.
- [fix] Two rows of an image's right-click menu no longer claim the same
  double-click.
- [faster] **Importing pictures is lighter on memory**, now that the small copy
  is asked for directly rather than decoded out of the full size.
- [faster] The right-click menu on a large selection opens without comparing
  every card to every other card first.

## On the Record
version: 0.188 - 0.196
date: 13 - 14 August 2026

- [new] **The changelog is a page of the app now**, printed by the app's own
  stylesheets under the app's own sidebar and reached from System.
- [new] **It is printed the way your board is printed**, so moving the whimsy
  dial while you are reading moves the page in front of you.
- [new] **Nothing you touch on the changelog is kept**, because the page never
  opens your session and never writes a preference.
- [new] **`Canvas`, `Feed` and `Playlist` take you back to the board**, each on
  the face you pressed.
- [new] **Everything that needs a board is greyed on the changelog rather than
  missing from it.**
- [fix] **The menu button stopped fading away on the changelog**, where a faded
  control took no clicks and was the only way in.
- **The whole record was rewritten**, which is why the entries below this one are
  longer than they were.

### Maintenance

- **The last two files carrying an exemption from the type checker were typed**,
  and the count is zero.
- **The script that commits also builds**, so a build that fails stops the commit
  rather than warning about it.

## Under the Floor
version: 0.156 - 0.187
date: 12 - 13 August 2026

- **Almost nothing here is visible on a board**, because the release went on
  rewriting the app in a language that checks itself and taking it apart into
  smaller pieces.
- [fix] **The app now tells you when something goes wrong**, on the board, in
  words.
- [fix] **Hovering works on a laptop that reports itself as a touchscreen.**
- [fix] **The buttons round the edge of the board react to the pointer again in
  Chrome.**
- [new] **The hint cards show on the Feed**, which used to open as an empty
  column on a brand-new board.
- [fix] A card no longer takes the accent outline just for being pointed at,
  since that mark means _selected_.
- [fix] The slider thumb stopped leaking its fill past its own border.

### Maintenance

- **Written in TypeScript and shipped as one file**, so a board downloads one
  script instead of fetching the whole tree.
- **A Content-Security-Policy, with a test that keeps it honest.**
- **The two largest files were split up**, and a test now enforces the rule about
  which piece may reach for which.

## The Viewer
version: 0.145 - 0.155
date: 12 August 2026

- [new] **Open one thing as big as the window will allow**, with the board
  waiting behind it.
- [new] **Documents open properly:** Word, OpenDocument, slides, spreadsheets,
  CSV, SVG and comic archives.
- [new] **A PDF opens page by page**, so a long one starts reading before the
  whole file has been parsed.
- [new] **Markdown is set as prose**, on the card and in the viewer.
- [new] **A document shows the picture it already has of itself**, which most of
  these formats carry inside them.
- [new] A dropped text file shows **its opening words** on the Feed instead of
  its name.
- [new] The Feed has a **right-click menu**, which it had gone without since it
  arrived.

## Both Hands
version: 0.135 - 0.144
date: 12 August 2026

- **The phone and the desk stopped pretending to be each other**, and each layout
  is now placed on its own terms.
- [new] **Colour, Link and Stickers moved behind a More button on the phone**, so
  the toolbar holds what you reach for.
- [new] **The Board tab was rebuilt** around one primary section and one fold,
  with a View row at the top.
- [fix] **The note composer drew its sheet at life size, off to the left.**
- [fix] **The sticker drawer shuts the moment a shape is dragged out of it.**
- [fix] **The Feed is printed on paper again**, after a spell on untextured stock.
- [fix] The phone toolbar handle no longer shows a square corner while pressed.
- [fix] The pen no longer comes down as soon as the Feed's title page has
  scrolled away.
- [fix] The Debug section is folded, so the System tab no longer ends on a
  footnote.

## Threads and Shapes
version: 0.130 - 0.134
date: 12 August 2026

- [new] **Draw a connection between two cards**, and edit it from a small chip
  that follows the line while it is selected.
- [new] **Stickers**, a drawer of shapes you can drag onto the board and tint
  from the board's own palette.
- [new] **Windows you can move and leave open**, of which the sticker drawer is
  the first and the Playlist the second.
- [new] **Hover flyouts on the toolbar**, so a tool with options shows them where
  the tool is.
- A full pass over the look of the app, with everything it found written down
  rather than quietly fixed.

## Feed and Playlist
version: 0.126 - 0.129
date: 11 August 2026

- [new] **The Feed**, a board read as one scrolling column instead of a cramped
  canvas.
- [new] **The Playlist**, every piece of audio on a board, as a player.
- [new] **More than one board**, in a switcher that holds them all with a picture
  of each.
- [new] **Save a picture of the board, or a PDF of it.**
- [new] **Share**, on a phone that has a share sheet, with the board going into
  it as a file rather than as a download.
- [new] **A PDF dropped on the board shows its first page**, as does every other
  format carrying a preview picture inside it.

## Regions
version: 0.117 - 0.125
date: 4 - 6 August 2026

- [new] **Fences**, a named region drawn on the board that the things inside it
  move with, readable at any zoom.
- [new] **A colour picker**, so a pigment can be chosen by eye rather than picked
  from a list.
- [new] **mbrd is on the web at an address**, with a 404 that is the app itself.
- [new] **The browser's copy of a board is tidied on every save**, so pictures
  belonging to something deleted a week ago stop taking up room.
- [new] At the softer end of the look, a region is drawn as a **cork board**,
  with the stock to match.
- [new] The whole app moved onto **one set of drawn icons** rather than the
  characters it had been borrowing.
- [fix] **Dropping a folder of more than five hundred files now says so**, where
  the cut was always made and the receipt never mentioned it.

## Grain and Credit
version: 0.106 - 0.116
date: 1 - 4 August 2026

- [new] **The paper got its tooth**, a real 300gsm grain that travels with the
  board as you pan and zoom.
- [new] **A now-playing bar** for whatever the board is playing.
- [new] **A credits sheet** for the two people who made this.
- [new] **The toolbar**, in the shape it still has.
- [new] **Threads route around the cards they pass** instead of running under
  them.
- [new] **A second typeface to set the app in**, Playfair, which gives the softer
  end of the dial a face with some weight to it.
- Maintenance: the single stylesheet the whole app had grown into was split into
  one file per subsystem, and the first full audit of the code was written down.

## Solid Ground
version: 0.87 - 0.105
date: 31 July 2026

- **A release about the board staying smooth while it moves, and about not
  losing anything.**
- [faster] **Editing a note no longer drags the whole board down**, now that its
  little toolbar works out where to sit from what the board already knows.
- [faster] **The grid stops redrawing when nothing has moved**, which is most of
  the tail of a flicked pan.
- [faster] **Zooming out does less work per frame**, checking what has left the
  view about eight times a second rather than on every one.
- [faster] **Exporting no longer holds the whole board in memory twice**, writing
  straight from where the files already sit.
- [faster] **Saving and reopening a board full of photographs is much quicker**,
  without one round trip to storage per picture.
- [faster] **Dragging a colour stops writing to disk sixty times a second**, and
  saves about five times a second instead.
- [fix] **A picture from a board you had already closed can no longer reappear on
  the next one.**
- [fix] **Undo stopped holding on to more than it should**, now that heavy
  actions declare their true cost.
- [fix] **A board with an unresolved conflict refuses to save** rather than
  writing something half-merged over the good copy.
- [fix] A stuck database connection is cleaned up rather than left open with
  nobody holding it.

### Maintenance

- **The central file became seven**, and nothing that used any of it had to
  change.

## Measured
version: 0.59 - 0.86
date: 28 - 31 July 2026

- **Worked on against measurements rather than impressions**, taken against the
  display's own refresh and kept.
- [faster] **Panning and zooming a large board** now costs what is on the screen
  rather than what is on the board.
- [faster] **Photographs are mounted at a sensible size** for how large they are
  actually being drawn.
- [faster] **A video does not load until it is first played on a touch device.**
- [faster] Zoomed out, image decoding and card shadows are shed entirely.
- [new] **A redrawn app icon:** three cards on the grid.
- [new] Cards **animate out when they leave**, so something deleted reads as
  having gone rather than as having never been there.
- **The phone scroll campaign ended in no rewrite**, and that is the finding.

## Hardening
version: 0.53 - 0.58
date: 28 July 2026

- **The boundaries where a file comes in were tightened**, so a malformed or
  hostile file is refused rather than trusted.
- [new] **A ceiling on what one drop may bring in**, so a folder pointed at the
  board by accident is refused with a sentence.
- [new] **Sticky notes were rebuilt**, from how a note sizes itself to what
  happens to one too long for its own card.
- [faster] **Only what is on screen is worked on**, so the cost of a gesture
  stopped scaling with the size of the board.
- [fix] **Gestures snap to the board's real grid**, not to the lattice as it
  appears at the current zoom.
- Every bundled typeface now carries its provenance and its licence.

## Pigment and Paper
version: 0.41 - 0.52
date: 26 - 27 July 2026

- [new] **The palette is read off your own pictures**, taking the board's sheet,
  ink and accent from the photographs pinned to it.
- [new] **`Optimize`**, one menu item that trims a board down to what a board
  actually needs.
- [new] **Real size**, so a paper outline dragged to scale tells you how big
  something is in millimetres or in inches.
- [new] **mbrd is installable properly**, with icons at both sizes and in the
  masked shape a phone crops to.
- [new] **A zoom pill and a scale bar** at the edge of the board.
- [new] **The furniture steps back when you leave the board alone**, and comes
  back the moment you touch anything.
- [new] **A masthead on the phone**, holding the board's name and the way into
  everything else.
- [new] **A live font switcher**, so each of the two type voices is chosen while
  you look at the result.

## First Light
version: 0.00 - 0.40
date: 25 July 2026

- **mbrd arrived**, an infinite freeform board in a browser tab with no account,
  no server and nothing uploaded, all of it built in a day.
- [new] **The whimsy axis**, one dial that takes the whole interface from
  scrapbook to spec sheet.
- [new] **Notes, links, audio cards, pictures and 3D models**, with album art
  filling a music card and Markdown in a note.
- [new] **A web of threads between items**, drawn at whatever density the machine
  can afford.
- [new] A bin that greys out when it is empty, renaming in place, and Find on the
  board with `Ctrl+K`.
- [new] **A board you can hold in one hand**, and the file format the whole thing
  saves to, specified and written down.
- [new] **Save keeps the board in this browser and Export writes a file you can
  put somewhere.**
