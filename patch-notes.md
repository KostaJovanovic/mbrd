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

## Every Corner
version: 0.207 - 0.230
date: 15 - 16 August 2026

- **The app was read end to end against its own stated intentions**, and the
  hundred and forty-five places where the two had come apart were repaired. One
  thing was added along the way. Everything else here is something that was
  already meant to work.

### What is new

- [new] **A multi-select mode, for a finger.** While it is on, a tap on a card
  adds it to what is picked rather than replacing it, and nothing you do to the
  board underneath - a pan, a tap on bare ground, opening the menu - clears the
  selection. It ends from the row it was started from, from `Esc`, or from
  opening another board.
- [fix] **PDFs draw on the live site.** The reader was fetched from another host,
  which the site's own security rules refuse, so every PDF and `.ai` card fell
  back to grey for everyone except somebody running the app on their own
  machine. It ships with mbrd now.

### Work nobody could have known was at risk

- [fix] **A note keeps its alignment and its markers through an export and a
  re-import.** The board file carried both all along; reading it back threw them
  away and rebuilt every note from its plain text.
- [fix] **A board that has lost one file can still be left.** It could not be
  saved, switched, replaced or exported, and the only way out the app offered
  was `Clear everything`.
- [fix] **Reloading while a board is still opening no longer writes a blank one
  over it.** On a heavy board that window is a few hundred milliseconds long,
  and hiding the tab inside it was enough.
- [fix] **Deleting a saved board asks first**, and names it. It was one tap on a
  small glyph in the corner of a card whose whole face means Open, with no
  confirmation, no undo and no bin.
- [fix] **Two boards stashed at once no longer lose one of them**, and the shelf
  is capped at twenty-four rather than growing until the browser refuses a write
  and the board on screen quietly stops saving.
- [fix] **Deleting a card no longer loses its place in the tour**, so restoring
  it from the bin brings the stop back with it.
- [fix] **A board carrying its own colours keeps them.** The four note markers, a
  card's shadow and how far a card leans were among the things a board file was
  allowed to set and the app then dropped on open.
- [fix] **The Timeline will not offer to fold away a history it cannot date.** A
  file whose steps carry no times read as older than any cutoff, so the offer
  covered this morning as well, and it does not come back.
- [fix] **A board old enough to carry its own video stills keeps them.** They
  were on neither of the two lists the cleanup checks against, so the first
  sweep after opening deleted them and the next export left them out.

### The ones that stopped the tab

- [fix] **A note stuck to itself, or two notes stuck to each other, ended the
  session on the first press.** Nothing you can do in the app makes one; a file
  can.
- [fix] **A 3D model no longer asks for more memory than the machine has.** A
  356-byte model was asking for 366 megabytes, and forty of them at once.
- [fix] **A picture claiming 30,000 pixels a side is refused in four more
  formats.** The browser decodes eight and the guard knew four, so a sixty-byte
  file could ask for three and a half gigabytes.
- [fix] **A note with a long run of backticks in it no longer locks the app**,
  measured at thirteen and a half seconds.
- [fix] **A big JPEG, a deep folder drop, a two-thousand-card phone board and a
  PDF with an enormous page** each stopped costing far more than they are worth.
- [fix] **`Join` with nothing selected no longer weighs every card on the board
  against every other**, and says so past two thousand rather than joining a
  sample nobody asked for.
- [fix] **Dragging a colour slider with the Timeline open is smooth again.**
  Every tick was re-measuring the whole history.
- [fix] **A pinned sticker on a locked photograph no longer kills every drag for
  the rest of the page.**
- [fix] **Lifting a second finger over the toolbar or off the edge of the window
  no longer leaves the app believing it is still down**, after which a plain tap
  panned and zoomed.

### Everything else you might have met

- [fix] **Pinching out of a drag puts the card back** rather than committing a
  move nobody made.
- [fix] **A second menu button opens its own menu.** Font then Highlight in the
  note bar, `More` then the palette on the toolbar: one closed and neither
  opened.
- [fix] **`Ctrl+K` works while the pointer is resting on a toolbar button**, and
  what you type reaches Find instead of being eaten a letter at a time by a menu
  that has not got the keyboard.
- [fix] **Find is a toggle**, and keeps what you typed rather than starting over.
- [fix] **A menu opened from a Feed tile acts on that tile**, not on whatever was
  selected on the canvas before you switched to it.
- [fix] **A save that fails says so**, rather than leaving the button reading
  `Saving...` for the rest of the session - and `Restart` still offers its
  dialog, which on a phone is the only way back to a fresh page.
- [fix] **The bar at the foot follows a track through its card being drawn and
  undrawn**, so it stops reading `0:00` under a `Play` button while the music is
  audible.
- [fix] **A play the browser refuses is reported.** Five places in the app can
  start a track and only one of them said anything, so pressing Play and getting
  silence now has a reason behind it.
- [fix] **The queue skips a track whose file has gone**, and moves on from one
  you deleted rather than starting again at the top.
- [fix] **A marked line keeps its marker** through Enter, through a paste and
  through a tidy-up, and the marker menu marks the lines that were selected when
  you opened it.
- [fix] **Going back to an earlier step no longer leaves the old undo stack
  standing.** The next `Ctrl+Z` wrote one era's positions onto another's, and
  the board could then be saved that way.
- [fix] **An anchored card survives a rearrange and a reflow**, including a
  change of column count or spacing on a phone.
- [fix] **The step editor offers the arrangements the board it is on has**, not
  the other board's.
- [fix] **A line between two cards re-routes when the card in its way moves.** It
  held the old detour until one of its own ends was dragged.
- [fix] **A board that fails to start shows the failure**, instead of a grey
  sheet over a message nobody can read.
- [fix] **The app stops calling a board saved before it has read one**, and says
  plainly when what is on screen is not being kept.
- [fix] **A dropped connection to the browser's store is picked up again**, where
  it used to latch and write nothing for the rest of the session.
- [fix] **A card hands back what it holds when it is rebuilt.** A rename, a crop,
  an adjust or a `Fit` toggle each left a photograph's decode and a video's
  decoder behind.
- [fix] **A frozen GIF gives its picture back**, once per freeze rather than
  never.
- [fix] **Opening the note editor no longer blanks the card behind it**, or
  leaves a second copy of it on the board afterwards.
- [faster] **Zooming out no longer visits every card on the board** to find the
  title card.
- [faster] **The performance readout stopped measuring itself**, four times a
  second, worst on the slow machines it exists for.
- Reading the changelog at a `/patch/` address with a trailing slash no longer
  takes your whimsy dial and your palette home with you.

### Maintenance

- **The suite went from 1,335 cases to 1,545**, and a first pass through it
  replaced the ones that could not fail.
- **Six rearrangements that change nothing on screen**: the board and the Feed
  pack by one masonry, the export and the screen share one grid policy, the
  ground is repainted through one door, a track's name and a note's first words
  are each worked out in one place, and the order things start up in is a test
  rather than a comment.
- **What a press means can now be asked in a test**, which is the half of the
  gesture pipeline nothing could reach before.

## Room to Look
version: 0.202 - 0.206
date: 15 August 2026

- **An hour spent driving the app and writing down every place the same command
  turns up twice**, and then the cut. Plus a picture you can finally get close
  to.
- [new] **A picture opened from the board zooms and pans.** Wheel or pinch to go
  in, drag to move about, a plain click for a closer look, and eight times as
  far in as it starts. The zoom goes to the point under the cursor rather than
  to the middle of the window, so pointing at a face keeps the face.
- [new] **A line of a note can be drawn over with a marker**, in _four_ colours,
  the way a highlighter is.
- [new] **The style tile is a card on the board rather than a picture you save.**
  It carries the board's pictures, its pigments and its two faces, and it is
  live: move the palette or the whimsy dial and every tile on the board follows
  in the same frame.
- [new] **`Flip` and `Flop` in the darkroom**, mirroring a picture left to right
  or top to bottom.
- [new] **A crop reshapes the card it is in**, so a 16:9 slice of a square
  photograph stops being letterboxed inside a square. The area is held, which is
  what stops a crop quietly making a card louder or quieter on the board.
- [new] **A clip with no still gets one in the background**, a frame at a time
  while nothing else is happening, so a board saved before stills existed stops
  drawing black rectangles.
- [new] **Something large is asked about before it comes in**, once for the whole
  drop, rather than two minutes into hashing and decoding it.
- [fix] **The right-click menu on empty board is six rows rather than twelve**,
  and the six that went were the ones already resting somewhere you could see
  without doing anything.
- [fix] **`Fill the card` and `Fit in the card` no longer both carry a tick.**
  They are one choice, and the tick now says which.
- [fix] **The toolbar steps out of the way whenever a panel is open**, at every
  width. It used to do it only below 1080 pixels, and the bar has grown twice
  since that number was chosen - so the first tool sat under the panel while the
  other seven looked perfectly fine.
- [fix] **A picture desaturates all the way to grey again.** Zero on the
  saturation dial was being read as no answer at all, so the slider sprang back
  to the middle at the far left and greyscale could not be reached.
- [fix] **Resizing a note rewraps what it says rather than rescaling it**, and a
  note grown by a line no longer comes back needing another one.
- [fix] **`No card` takes the shadow with it**, in both directions. An emptied
  sticky was leaving a shadow with nothing casting it.
- [fix] At the spec-sheet end of the whimsy axis a cut-out is no longer given a
  mat, a chin and a hairline round the outside - a frame round nothing, which is
  the thing a cut-out exists to be free of.
- [fix] **The Playlist lens gave up the transport it carried.** The bar along the
  foot is already one and does not move when the list does, so the lens is now
  the two things a bar cannot be: how a board is started, and how a track is
  chosen.
- [fix] **An anchored card is something an arrangement keeps clear of** rather
  than something it deals a slot to and lays another card on top of.
- [fix] Going to a step in the Timeline that a later edit had changed no longer
  rebuilds from a picture of a board that never existed.
- [fix] A paste, an anchor and an unanchor are named in the Timeline instead of
  arriving as unlabelled steps.

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
