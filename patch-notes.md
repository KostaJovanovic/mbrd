# mbrd patch notes - the source

THE ONLY PLACE THE PAGE'S PROSE IS WRITTEN. One thing is generated from this
file by `node tools/gen-patch-page.mjs`, and it may not be hand-edited:

  web/patch.html   the changelog as a document, dressed by the app's own sheets

/patch is a document and nothing else. It takes index.html's head - the fonts,
the whole cascade in order, and the pre-paint script that puts the reader's
saved look on the page - and then its own prose. No sidebar, no toolbar, no
board, no bundle. What it borrows from the app is how it is printed: the whimsy
dial the reader set on their own board is already on the page when it arrives,
so the changelog is a scrapbook at one end of that axis and a spec sheet at the
other.

## What goes on the page, and what does not

**Only what a person using the app would notice.** That is the whole selection
rule and it is worth stating first, because it is the one this file used to get
wrong. A reader opens /patch to find out what is different for them. Bullets
about module splits, type migrations, test counts and layering rules do not add
to that answer - they bury it, and a page where the six entries that matter are
mixed into forty that do not is a page nobody finishes.

So: a feature, a repair somebody could have hit, or a speed-up somebody could
have felt. Nothing else. If a release genuinely has nothing in it for them, say
so in one plain line and move on.

**The long version is kept, and it is kept somewhere else.**
`research/patch-notes-full.md` holds every release at the length it was first
written at, the internal work included. It is an archive - nothing generates
anything from it - and it is where to look for the whole story of a release
rather than the part of it that changed what the app does.

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
the newest one must equal VERSION in web/assets/js/version.js. The page prints
that version in its foot, read straight off version.js rather than off this
file, so the two disagreeing is visible on the page itself.

The spans are contiguous and they cover everything. Every commit from the first
to the current one falls inside exactly one release, which is the property that
makes a gap in the record visible instead of plausible. This was not true until
v0.195: four runs of commits - 0.22 to 0.40, 0.76 to 0.86, 0.93 to 0.104 and
0.152 to 0.155 - fell between two spans and were described by neither, while
several of the things done in them had been quietly folded into the bullets of a
release whose number did not contain them. When a new release is written, the
one below it ends at the number below its own.

A release covering a run of commits that produced nothing a reader would notice
is still written, still spans its commits, and says as much in a sentence. The
span is the record; the bullets are the news, and a release is allowed to have
none.

`date:` is `13 August 2026`, or `4 - 6 August 2026` where the release spans
days. From `git log -1 --format=%ad`.

A `###` heading divides a long release into named parts. Most releases do not
need one - if a trimmed release wants three headings it is probably still
carrying entries that belong in the archive.

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

Separators are ` - `, a spaced hyphen. Never an em-dash: this whole repository
is em-dash-free on purpose. No emoji. `**bold**` around the thing a bullet is
about, `_word_` for the one accent-coloured word, backticks for a literal
string from the interface.

## Releases

## Face Up
version: 0.231 - 0.252
date: 16 - 18 August 2026

- A release about cards that used to be blank. A great many files that dropped
  in as a grey rectangle with a name on it now show their own picture, and the
  clips that would not preview at all finally do.
- [new] **Documents and design files show the thumbnail they were saved with.**
  Word, Excel, PowerPoint, Pages, Numbers, Keynote and OpenDocument files, the
  older `.doc`, `.xls` and `.ppt` from before those, and Visio, Krita,
  Procreate, SolidWorks and 3ds Max files besides - each arrives as a
  recognisable picture rather than a named blank.
- [new] **Programs and app packages show their own icon.** A Windows `.exe` or
  `.dll` shows the same icon Explorer draws for it, and an Android `.apk`, an
  iOS `.ipa`, a Windows `.appx`, an ebook (`.epub`), a comic (`.cbz`) or a
  3D-print package (`.3mf`) shows its icon or its cover.
- [new] **Camera RAW and HEIC photos show a real image.** The app pulls out the
  preview the camera tucked inside, so a folder of `.cr2`, `.nef`, `.arw`,
  `.dng` or `.heic` files is a wall of pictures again instead of grey cards.
- [new] **Clips a browser cannot play still get the right shape and facts.** AVI,
  WMV, FLV, MPEG and their kind now carry their true length and dimensions, so
  the card fits the video rather than guessing at it.
- [fix] **Video previews now appear on Android phones and on Firefox.** A clip
  used to land as a blank card there, and a phone's own camera footage was the
  exact case that failed. The app now reads the first frame another way and
  shows it.
- [fix] **Photo-heavy boards no longer run older iPhones and iPads out of
  memory.** The picture-shrinking that keeps a big board inside a tab's memory
  had quietly stopped working on Safari before 16.4, where a couple of dozen
  photos could crash the tab. It works there now.
- [new] **The playback bar has a proper transport** - a large round play/pause
  button at its head, and a `Next` button beside it while a playlist runs, in
  place of the old row of small controls.
- [fix] **Emptying the bin actually frees the space.** A deleted file's data
  used to travel on inside the board and be written into every save afterwards,
  so a board you had cleared out still weighed as much as before. Emptying the
  bin now removes it for good.

## Every Corner
version: 0.207 - 0.230
date: 15 - 16 August 2026

- **The app was read end to end against its own stated intentions**, and the
  places where the two had come apart were repaired. One thing was added along
  the way. Everything else here is something that was already meant to work.
- [new] **A multi-select mode, for a finger.** While it is on, a tap on a card
  adds it to what is picked rather than replacing it, and nothing you do to the
  board underneath - a pan, a tap on bare ground, opening the menu - clears the
  selection. It ends from the row it was started from, from `Esc`, or from
  opening another board.
- [fix] **PDFs draw on the live site.** The reader was fetched from another host,
  which the site's own security rules refuse, so every PDF and `.ai` card fell
  back to grey for everyone except somebody running the app on their own
  machine. It ships with mbrd now.
- [fix] **A note keeps its alignment and its markers through an export and a
  re-import.** The board file carried both all along; reading it back threw them
  away and rebuilt every note from its plain text.
- [fix] **Deleting a saved board asks first**, and names it. It was one tap on a
  small glyph in the corner of a card whose whole face means Open, with no
  confirmation, no undo and no bin.
- [fix] **A board that has lost one file can still be left.** It could not be
  saved, switched, replaced or exported, and the only way out the app offered
  was `Clear everything`.
- [fix] **Reloading while a board is still opening no longer writes a blank one
  over it.** On a heavy board that window is a few hundred milliseconds long,
  and hiding the tab inside it was enough.
- [fix] **Two boards stashed at once no longer lose one of them**, and the shelf
  is capped at twenty-four rather than growing until the browser refuses a write
  and the board on screen quietly stops saving.
- [fix] **A board carrying its own colours keeps them.** The four note markers, a
  card's shadow and how far a card leans were among the things a board file was
  allowed to set and the app then dropped on open.
- [fix] **Deleting a card no longer loses its place in the tour**, so restoring
  it from the bin brings the stop back with it.
- [fix] **A handful of files that could stop the tab cannot any more.** A model
  asking for more memory than the machine has, a picture claiming thirty
  thousand pixels a side, a note with a long run of backticks in it: each is now
  refused or handled rather than taking the page down with it.
- [fix] **A save that fails says so**, rather than leaving the button reading
  `Saving...` for the rest of the session.
- [fix] **Find is a toggle**, and keeps what you typed rather than starting over.
  `Ctrl+K` also works while the pointer is resting on a toolbar button, where
  what you typed used to be eaten a letter at a time.
- [fix] **A menu opened from a Feed tile acts on that tile**, not on whatever was
  selected on the canvas before you switched to it.
- [fix] **Pinching out of a drag puts the card back** rather than committing a
  move nobody made.
- [fix] **The queue skips a track whose file has gone**, and moves on from one
  you deleted rather than starting again at the top. A play the browser refuses
  is now reported instead of being silence with no reason behind it.
- [fix] **A marked line keeps its marker** through Enter, through a paste and
  through a tidy-up.
- [fix] **A line between two cards re-routes when the card in its way moves.** It
  held the old detour until one of its own ends was dragged.
- [faster] **Dragging a colour slider with the Timeline open is smooth again.**
  Every tick was re-measuring the whole history.

## Room to Look
version: 0.202 - 0.206
date: 15 August 2026

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
- [new] **A crop reshapes the card it is in**, so a 16:9 slice of a square
  photograph stops being letterboxed inside a square. The area is held, which is
  what stops a crop quietly making a card louder or quieter on the board.
- [new] **`Flip` and `Flop` in the darkroom**, mirroring a picture left to right
  or top to bottom.
- [new] **A clip with no still gets one in the background**, a frame at a time
  while nothing else is happening, so a board saved before stills existed stops
  drawing black rectangles.
- [new] **Something large is asked about before it comes in**, once for the whole
  drop, rather than two minutes into hashing and decoding it.
- [fix] **The right-click menu on empty board is six rows rather than twelve**,
  and the six that went were the ones already resting somewhere you could see
  without doing anything.
- [fix] **The toolbar steps out of the way whenever a panel is open**, at every
  width. It used to do it only below 1080 pixels, and the bar has grown twice
  since that number was chosen - so the first tool sat under the panel while the
  other seven looked perfectly fine.
- [fix] **A picture desaturates all the way to grey again.** Zero on the
  saturation dial was being read as no answer at all, so the slider sprang back
  to the middle at the far left and greyscale could not be reached.
- [fix] **Resizing a note rewraps what it says rather than rescaling it**, and a
  note grown by a line no longer comes back needing another one.
- [fix] **`Fill the card` and `Fit in the card` no longer both carry a tick.**
  They are one choice, and the tick now says which.
- [fix] **An anchored card is something an arrangement keeps clear of** rather
  than something it deals a slot to and lays another card on top of.
- [fix] **The Playlist lens gave up the transport it carried.** The bar along the
  foot is already one and does not move when the list does, so the lens is now
  the two things a bar cannot be: how a board is started, and how a track is
  chosen.

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
- [new] **The Timeline offers to fold steps older than thirty days into the
  starting point**, leaving the board _unchanged_ and the named landmarks where
  they are.
- [new] **Exporting asks whether to send the history with the board**, and the
  answer already under your thumb is to leave it out.
- [new] **`Board contents` takes you to the card**, so pressing a row in the list
  of heaviest files travels the board to whatever is using it.
- [new] **The board file names its own parts**, so a `.mbrd` renamed to `.zip`
  opens with the pictures under the names of the cards they sit on.
- [new] The palette menu draws each palette as a bar of its own colours down the
  trailing edge, where they line up and can be read against each other.
- [fix] **Hovering a card animates again**, after several releases of the lift,
  the tilt and the ring arriving instantly.
- [fix] **A note no longer sticks to the pointer after you change its face.**
- [faster] **A board carrying an embedded typeface saves quicker.**
- The three lines on an empty board now say what the board is for rather than
  listing what you are allowed to drop on it.

## Second Thoughts
version: 0.197 - 0.197
date: 14 August 2026

- [new] **`What is in this board` says where the weight went**, counting by kind
  and naming the ten heaviest files and anything stored that no card uses any
  more.
- [new] **A style tile joins the two ways of saving a picture**, carrying the
  palette, the faces, a few of the pictures, the name and the date.
- [new] **A cut-out picture can drop its card**, landing on the board as the
  shape rather than in a box.
- [fix] **The Join tool no longer accepts a join it cannot draw**, and boards
  already carrying one have it cleaned out when they open.
- [faster] **Importing pictures is lighter on memory**, now that the small copy
  is asked for directly rather than decoded out of the full size.

## On the Record
version: 0.188 - 0.196
date: 13 - 14 August 2026

- [new] **The changelog is a page of the app now**, reached from System, and
  printed the way your own board is printed - so the look you set is the look
  you read it in.
- [new] **Nothing you touch on the changelog is kept.** The page never opens your
  session and never writes a preference.

## Under the Floor
version: 0.156 - 0.187
date: 12 - 13 August 2026

- **Almost nothing here is visible on a board.** The release went on rewriting
  the app in a language that checks itself and taking it apart into smaller
  pieces, which is work that pays for itself later and shows nothing now.
- [fix] **The app now tells you when something goes wrong**, on the board, in
  words.
- [fix] **Hovering works on a laptop that reports itself as a touchscreen.**
- [fix] **The buttons round the edge of the board react to the pointer again in
  Chrome.**
- [new] **The hint cards show on the Feed**, which used to open as an empty
  column on a brand-new board.

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

## Solid Ground
version: 0.87 - 0.105
date: 31 July 2026

- **A release about the board staying smooth while it moves, and about not
  losing anything.**
- [faster] **Editing a note no longer drags the whole board down.**
- [faster] **The grid stops redrawing when nothing has moved**, which is most of
  the tail of a flicked pan.
- [faster] **Saving and reopening a board full of photographs is much quicker**,
  without one round trip to storage per picture.
- [faster] **Exporting no longer holds the whole board in memory twice.**
- [faster] **Dragging a colour stops writing to disk sixty times a second.**
- [fix] **A picture from a board you had already closed can no longer reappear on
  the next one.**
- [fix] **A board with an unresolved conflict refuses to save** rather than
  writing something half-merged over the good copy.

## Measured
version: 0.59 - 0.86
date: 28 - 31 July 2026

- **Worked on against measurements rather than impressions**, taken against the
  display's own refresh and kept.
- [faster] **Panning and zooming a large board** now costs what is on the screen
  rather than what is on the board.
- [faster] **Photographs are mounted at a sensible size** for how large they are
  actually being drawn, and zoomed out the app sheds image decoding and card
  shadows entirely.
- [faster] **A video does not load until it is first played on a touch device.**
- [new] **A redrawn app icon:** three cards on the grid.
- [new] Cards **animate out when they leave**, so something deleted reads as
  having gone rather than as having never been there.

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
