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

## On the Record
version: 0.188 - 0.195
date: 13 - 14 August 2026

- [new] **The changelog is a page of the app now, and this is it.** It used to be
  a text file nobody outside the repository could read, then a board drawn out of
  one. It is neither: it is a document, printed by the app's own stylesheets,
  with the app's own sidebar over it. Reached from System - What changed.
- [new] **It is printed the way your board is printed.** The page reads your
  saved look before it paints, so the whimsy dial prints the changelog three
  ways - a scrapbook at one end, a straightened room in the middle, a spec sheet
  at the other - and moving the dial while you are reading moves the page in
  front of you. Nothing you touch there is kept: the page never opens your
  session and never writes a preference, so a look tried out on the changelog is
  forgotten the moment you leave.
- [new] **`Canvas`, `Feed` and `Playlist` take you back to the board.** They are
  the one row of the sidebar that still means something on a page with no board,
  so on the changelog they mean the only thing they can - and the face you press
  is the face the board opens on.
- [new] **Everything that needs a board is greyed there instead of missing.**
  `Save`, `Export`, `Add files`, the arrangement, the grid, the paper sheet,
  `Optimize` and `Clear everything` are all visible and all switched off. The
  whimsy dial, the palette and the quality settings are not among them, because
  those move the page you are actually looking at.
- [fix] **The menu button stopped fading away on the changelog.** The furniture
  around a board steps back when you leave it alone, which on a page of prose
  faded the one control the page has - and a faded control stops taking clicks,
  so the sidebar could not be opened at all.
- **The whole record was rewritten, which is why the entries below this one are
  longer than they were.** Four runs of versions had fallen through the gaps
  between releases and were described nowhere; several features that shipped
  months of commits ago - the palette read off your own photographs, `Optimize`,
  the paper sheet and real-size measuring, installing the app, the board library
  - had never been mentioned at all. They are in their proper releases now,
  dated to when they actually landed rather than to when they were written up.

### Maintenance

- **The last two files carrying an exemption from the type checker were typed,
  and the count is zero.** The migration renamed a hundred and five modules in
  one step and carried a hundred and three of them unchecked; the number has
  come down every release since and this is the one that closes it. It is a
  plain guard now rather than a countdown - a file that asks for the exemption
  back fails the suite.
- **The script that commits also builds.** What reaches a visitor is whichever
  bundle was last committed, and the bundle was only ever as fresh as the last
  time somebody happened to build it by hand. Now a build that fails stops the
  commit rather than warning about it.

## Under the Floor
version: 0.156 - 0.187
date: 12 - 13 August 2026

- **Almost nothing here is visible on a board**, and it would be dishonest to
  pretend otherwise. This is the release where the app was rewritten in a
  language that checks itself, taken apart into smaller pieces, and given a
  policy that limits what a page is allowed to do. What it buys you is fewer of
  the faults below arriving in the first place.
- [fix] **The app now tells you when something goes wrong.** A failure that used
  to end in a half-finished board and a message only the browser console ever saw
  now says what happened, on the board, in words.
- [fix] **Hovering works on a laptop that reports itself as a touchscreen.**
  Two-in-one machines say they have a finger even when a mouse is on them, and
  everything that appears when you point at it was staying hidden.
- [fix] **The buttons round the edge of the board react to the pointer again in
  Chrome.** The menu button, the bin, the zoom pill and the panel close had all
  gone still on desktop Chrome, which reports itself as a touchscreen with no
  touchscreen attached. The menu button was the tell: its three bars changed
  colour and the button under them did not.
- [new] **The hint cards show on the Feed.** The three cards a brand-new board
  opens with had only ever been drawn on the canvas, so opening the app on a
  phone gave you an empty column and no suggestion of what to do with it.
- [fix] A card no longer takes the accent outline just for being pointed at -
  that mark means _selected_, and spending it on a hover left nothing to say
  which card you had actually chosen.
- [fix] The slider thumb stopped leaking its fill past its own border, which
  showed as a bright hairline round every dial in the panel.

### Maintenance

- **Written in TypeScript and shipped as one file.** Ninety-odd source modules
  are compiled and bundled, so a board now downloads one script instead of
  fetching the whole tree - and a whole class of mistake is caught before it can
  ship.
- **A Content-Security-Policy, with a test that keeps it honest.** The page now
  declares exactly what it is allowed to load and where from, which is the
  difference between a bug being a bug and a bug being a way in.
- **The two largest files were split up** - the one that owned every board
  operation, and the one that styled every card - and a test now enforces the
  rule about which piece may reach for which. Continuous integration runs the
  suite, the types and the linter on every push.

## The Viewer
version: 0.145 - 0.155
date: 12 August 2026

- [new] **Open one thing as big as the window will allow.** Anything on the board
  can now be lifted off it and shown full size, with the board waiting behind - a
  photograph at its real resolution, a video with its own controls, a document
  you can read.
- [new] **Documents open properly:** Word, OpenDocument, slides, spreadsheets,
  CSV, SVG and comic archives. Not a download prompt and not a filename - the
  actual pages, read in the app.
- [new] **A PDF opens page by page**, so a long one starts reading immediately
  instead of after the whole file has been parsed.
- [new] **Markdown is set as prose**, on the card and in the viewer - headings,
  lists, quotes and links, rather than the asterisks you typed.
- [new] **A document shows the picture it already has of itself.** Most of these
  formats carry a preview image inside them, and using it means a card that looks
  like its contents without anything having to be rendered.
- [new] A dropped text file shows **its opening words** on the Feed instead of
  its name.
- [new] The Feed has a **right-click menu**, which it had gone without since it
  arrived.

## Both Hands
version: 0.135 - 0.144
date: 12 August 2026

- **The phone and the desk stopped pretending to be each other.** The two
  layouts had been one design with things hidden out of the smaller one; each is
  now placed on its own terms, and what the desk was missing was put there rather
  than copied across.
- [new] **Colour, Link and Stickers moved behind a More button on the phone**, so
  the toolbar holds what you reach for and not everything that exists.
- [new] **The Board tab was rebuilt** around one primary section and one fold,
  with a View row at the top that says which of the three faces of a board you
  are looking at.
- [fix] **The note composer drew its sheet at life size, off to the left** -
  writing a note meant aiming at a box that was not where it appeared to be.
- [fix] **The sticker drawer shuts the moment a shape is dragged out of it**,
  instead of staying open over the place you were dragging the shape to.
- [fix] **The Feed is printed on paper again.** It had been on untextured stock
  since it replaced the old strip, so the phone board was the one surface in the
  app with no tooth to it.
- [fix] The phone toolbar handle showed a square corner while pressed, the pen
  came down as soon as the Feed's title page had scrolled away, and the Debug
  section was folded so the System tab no longer ends on a footnote.

## Threads and Shapes
version: 0.130 - 0.134
date: 12 August 2026

- [new] **Draw a connection between two cards**, and edit it from a small chip
  that follows the line while it is selected. A board can now say that this
  relates to that.
- [new] **Stickers** - a drawer of shapes you can drag onto the board, each
  tintable from the board's own palette rather than from a stock set of
  primaries.
- [new] **Windows you can move and leave open**, which the sticker drawer is the
  first of and the Playlist the second - a thing you keep reaching for stops
  being a menu that shuts behind you every time.
- [new] **Hover flyouts on the toolbar**, so a tool with options shows them where
  the tool is instead of sending you to a menu to look for them.
- A full pass over the look of the app, with everything it found written down
  rather than quietly fixed - including which parts were deliberately left alone.

## Feed and Playlist
version: 0.126 - 0.129
date: 11 August 2026

- [new] **The Feed** - a board read as one scrolling column instead of a cramped
  canvas. It is a way to browse what is on a board, not a smaller version of the
  board.
- [new] **The Playlist**: every piece of audio on a board, as a player.
- [new] **More than one board.** A switcher that holds them all, each with a
  picture of itself, so a board is no longer the single thing this browser
  happens to be holding.
- [new] **Save a picture of the board, or a PDF of it.** Until these two the only
  thing that ever left mbrd was a file only mbrd could open, which is an odd
  property for a thing made to be shown to somebody.
- [new] **Share**, on a phone that has a share sheet - the board goes into it as
  a file rather than turning quietly into a download.
- [new] **A PDF dropped on the board shows its first page**, and every other
  format that carries a preview picture inside it now uses that picture instead
  of standing there as a filename.

## Regions
version: 0.117 - 0.125
date: 4 - 6 August 2026

- [new] **Fences** - a named region drawn on the board rather than a card lying
  on it. Things inside one move with it, and its name is readable at any zoom,
  which is what makes a large board navigable.
- [new] **A colour picker**, so a pigment can be chosen by eye rather than picked
  from a list.
- [new] **mbrd is on the web at an address**, findable, and with a 404 that is
  the app itself: a mistyped path opens a board rather than a dead end, and the
  moment you put something on that board it becomes an ordinary one at the
  ordinary address.
- [new] **The browser's copy of a board is tidied on every save**, so pictures
  belonging to something you deleted a week ago stop taking up room you cannot
  see and cannot get back.
- [new] At the softer end of the look, a region is drawn as a **cork board**,
  with the stock to match, and the whole app moved onto **one set of drawn
  icons** rather than the characters it had been borrowing.
- [fix] **Dropping a folder of more than five hundred files now says so.** The
  cut was always made - the app stops at five hundred - but the receipt said it
  had brought in everything, so a thousand photographs became five hundred and
  nothing mentioned it.

## Grain and Credit
version: 0.106 - 0.116
date: 1 - 4 August 2026

- [new] **The paper got its tooth.** The sheet is a real 300gsm grain now,
  multiplied over the board and travelling with it as you pan and zoom, rather
  than a flat wash of colour.
- [new] **A now-playing bar** for whatever the board is playing, and a **credits
  sheet** for the two people who made this.
- [new] **The toolbar**, in the shape it still has.
- [new] **Threads route around the cards they pass**, instead of running under
  them - a line between two cards on a busy board now reads as a line rather than
  as something disappearing behind furniture.
- [new] **A second typeface to set the app in.** Playfair joined what the
  switcher offers, which is what gives the softer end of the dial a face with
  some weight to it rather than one voice doing every job.
- Maintenance: the single stylesheet the whole app had grown into was split into
  one file per subsystem, and the first full audit of the code was carried out
  and written down.

## Solid Ground
version: 0.87 - 0.105
date: 31 July 2026

- **A release about the board staying smooth while it moves, and about not
  losing anything.** Nothing new to look at; three costs paid on every frame of
  every gesture, and four faults closed behind them.
- [faster] **Editing a note no longer drags the whole board down.** While a note
  was open, its little toolbar measured itself four times a frame, at the worst
  possible moment - just after the board had moved - which made the browser
  recalculate the entire page's layout sixty times a second for as long as the
  note was open. It now works out where to sit from what the board already knows.
- [faster] **The grid stops redrawing when nothing has moved**, which is most of
  the tail of a flicked pan and most of what a trackpad sends while it settles.
- [faster] **Zooming out does less work per frame.** The check for what has left
  the view used to run on every frame of the whole gesture; it now runs about
  eight times a second while you move and once more the moment you stop.
- [faster] **Exporting no longer holds the whole board in memory twice.** Writing
  a `.mbrd` used to read every photo, video and sound into memory and then hold a
  second copy of each while the archive was assembled, so a board a browser could
  comfortably display was not necessarily one it could save. It is written
  straight from where the files already sit, a piece at a time.
- [faster] **Saving and reopening a board full of photographs is much quicker.**
  The background save made one separate trip to the browser's storage per
  picture, waiting for each before starting the next - five hundred photographs
  meant five hundred round trips, once on the way in and again on the way back.
- [faster] **Dragging a colour stops writing to disk sixty times a second.**
  Moving the picker saved your whole look on every frame of the drag, a blocking
  write on the same thread as the picture you were watching. It saves about five
  times a second now, and always once more on the way out.
- [fix] **A picture from a board you had already closed can no longer reappear on
  the next one.** mbrd makes a screen-sized copy of every photograph in the
  background; if you opened a different board - or moved the sharpness dial -
  while one was still being made, the finished copy arrived afterwards and
  quietly filed itself.
- [fix] **Undo stopped holding on to more than it should.** The history
  remembered its last two hundred actions and counted them all the same, so
  nudging two cards and nudging ten thousand cost the same one slot while the
  second quietly held two copies of the whole board's positions. Heavy actions
  now declare their true cost. The one thing never dropped is a single action
  bigger than the entire budget, which is precisely the one you are most likely
  to want back.
- [fix] **A board with an unresolved conflict refuses to save** rather than
  writing something half-merged over the good copy, and a stuck database
  connection - the kind that itself blocks the next tab - is now cleaned up
  rather than left open with nobody holding it.

### Maintenance

- **The central file became seven.** The bus and the dirty flag, the board's own
  shape, the undo engine, sticky-note relations, the two layouts and the
  front-to-back card order each moved into a file of their own, and the file that
  draws the threads stopped also being the file that decides where they go.
  Nothing that used any of it had to change.

## Measured
version: 0.59 - 0.86
date: 28 - 31 July 2026

- **Worked on against measurements rather than impressions**, which is the whole
  point of the entry: the readings were taken against the display's own refresh,
  the numbers were kept, and one of the two campaigns below ended in a decision
  not to build anything.
- [faster] **Panning and zooming a large board.** The cost of a frame stopped
  depending on how much was on the board and started depending on how much was on
  the screen.
- [faster] **Photographs are mounted at a sensible size** for how large they are
  actually being drawn, rather than at whatever the camera produced - a 4K photo
  on a card three inches wide was a 4K photo.
- [faster] **A video does not load until it is first played on a touch device**,
  and zoomed out, image decoding and card shadows are shed entirely.
- [new] **A redrawn app icon:** three cards on the grid.
- [new] Cards **animate out when they leave**, so something deleted reads as
  having gone rather than as having never been there.
- **The phone scroll campaign ended in no rewrite**, and that is the finding.
  Eleven versions went into measuring the Feed's scroll against the display's
  beat rather than against an average, and the conclusion was that the grid did
  not need rebuilding. Building against no measurement is how a regression ships,
  and so is rebuilding against one that says you do not have to.

## Hardening
version: 0.53 - 0.58
date: 28 July 2026

- **The boundaries where a file comes in were tightened** - what is stored, what
  is imported and what is drawn - so that a malformed or hostile file is refused
  rather than trusted. The readers that parse files this app did not write check
  their sizes before they allocate.
- [new] **A ceiling on what one drop may bring in**, so a folder pointed at the
  board by accident is refused with a sentence rather than absorbed until the tab
  dies.
- [new] **Sticky notes were rebuilt**: how a note sizes itself to what it says,
  where the writing sits on the sheet, and what happens to a note too long for
  its own card.
- [faster] **Only what is on screen is worked on.** The board keeps an index of
  where things are, so the cost of a gesture stopped scaling with the size of the
  board.
- [fix] **Gestures snap to the board's real grid**, not to the lattice as it
  appears at the current zoom - so a card dropped at 40% lands where one dropped
  at 100% would.
- Every bundled typeface now carries its provenance and its licence.

## Pigment and Paper
version: 0.41 - 0.52
date: 26 - 27 July 2026

- [new] **The palette is read off your own pictures.** Set the palette to
  `Dynamic` and the board takes its sheet, its ink and its accent from the
  photographs pinned to it - one to three hues, none of them invented, so a board
  of one colour gets a palette in one colour. How many pictures it reads is
  yours to set.
- [new] **`Optimize`** - one menu item that trims a board down to what a board
  actually needs. Photographs are re-encoded at the size they are drawn at, sound
  is re-encoded as Opus, and video is deliberately left alone. It never touches
  anything it cannot make meaningfully smaller, it never throws the originals
  away, and it is one undo from being reversed. Nothing runs on import, on save
  or on a timer: it happens because you asked.
- [new] **Real size.** Put a paper outline on the board - A4, Letter, portrait or
  landscape - drag its corners to set the board's scale, or point at something
  whose size you already know, and the board will tell you how big it is in
  millimetres or in inches.
- [new] **mbrd is installable properly.** It had claimed to be an app you could
  keep since the first day and had no icons to be kept as; it has them now, at
  both sizes and in the masked shape a phone crops to, so it goes on a home
  screen or into a dock and opens in its own window with the whole app already
  cached and no connection required.
- [new] **A zoom pill and a scale bar** at the edge of the board, so how far in
  you are is a number and a length rather than a guess.
- [new] **The furniture steps back when you leave the board alone**, and comes
  back the moment you touch anything.
- [new] **A masthead on the phone**, holding the board's name and the way into
  everything else, rather than the desk's controls squeezed sideways.
- [new] **A live font switcher**, so each of the two type voices is chosen while
  you look at the result rather than picked from a list and hoped for.

## First Light
version: 0.00 - 0.40
date: 25 July 2026

- **mbrd arrived.** An infinite freeform board in a browser tab, with no account,
  no server and nothing uploaded - and all of it was built in a day.
- [new] **The whimsy axis**: one dial that takes the whole interface from
  scrapbook to spec sheet - the corners, the type, the ornament and how much
  anything moves - and the palettes that ride on it.
- [new] **Notes, links, audio cards, pictures and 3D models**, with album art
  filling a music card, a YouTube link that becomes a player if you ask it to,
  and Markdown in a note.
- [new] **A web of threads between items**, drawn at whatever density the machine
  can afford, a bin that greys out when it is empty, renaming in place, and Find
  on the board with `Ctrl+K`.
- [new] **A board you can hold in one hand**, and the file format the whole thing
  saves to, specified and written down.
- [new] **Save, and Export**, which are two different things: one keeps the board
  in this browser, the other writes a file you can put somewhere.
