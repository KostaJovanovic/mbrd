# mbrd patch notes - the source

THE ONLY PLACE THE PAGE'S PROSE IS WRITTEN. `node tools/gen-patch-page.mjs`
builds one file from it, and that file may not be hand-edited:

  web/patch.html   the changelog as a document, dressed by the app's own sheets

/patch is a document and nothing else. It takes index.html's head - the fonts,
the whole cascade in order, and the pre-paint script that puts the reader's
saved look on the page - and then its own prose. No sidebar, no toolbar, no
board, no bundle. The one thing it borrows from the app is how it is printed:
the whimsy dial the reader set on their own board is already on the page, so the
changelog is a scrapbook at one end of that dial and a spec sheet at the other.

## What goes on the page, and what does not

**Write only what a person using the app would notice.** That is the whole
selection rule, and it comes first because it is the one this file used to get
wrong. A reader opens /patch to find out what is different for them. Bullets
about module splits, type migrations, test counts and layering rules do not
answer that. They bury it, and a page where the entries that matter sit among
the ones that do not is a page nobody finishes.

So: a feature, a repair somebody could have hit, or a speed-up somebody could
have felt. Nothing else. If a day has nothing in it for them, say so in one
plain line and move on.

**The cleaning simulator is never mentioned here, in any form.** Not the mode,
not the konami code or the seven taps that open it, not its tools, its dirt, its
sounds or the card a finished board is left. A thing found by accident stops
being found the moment a changelog names it, so the page stays silent about it
however large the day's work on it was. The archive carries that work instead.

**The long version is kept, and it is kept somewhere else.**
`research/patch-notes-full.md` holds every release at the length it was first
written at, the internal work included. It is an archive - nothing generates
from it - and it is where the whole story of a day lives, rather than the part
that changed what the app does.

## Versioning

The version is the commit count. `save.bat` stamps `COMMIT_COUNT` and `VERSION`
into `web/assets/js/version.js` on every commit, so commit number N is version
`0.NN`. A group carries the span of commit numbers its day covers, and the high
end of the newest group must equal `VERSION`. The page prints that number in its
foot straight off version.js, so the two disagreeing shows on the page itself.
Never let them drift.

Milestones are crowned, not reached. `RELEASE_COMMITS` in version.js holds the
commit numbers promoted to a major release - `1.0`, `2.0` and so on - mirrored
in `RELEASES` in save.bat. The list is empty for now, so every version is still
`0.NN`. To crown one, add its commit number to both, and give that day the
boldest codename on the page.

## One group per day

A group is a single day, and every commit of that day falls in it. The day does
not break at midnight. It breaks at 09:00: a commit before 9am counts as the day
before, so work done at 5am on the 15th belongs to the 14th. Take each commit's
time from `git log --format=%ad` and move it back nine hours to find its day.

On each save, if the new commits share the top group's day, extend that group:
move its version high end up, and add any bullets. If they open a new day, write
a new group above it.

The days are contiguous and they cover everything. Every commit from the first
to the current one falls inside exactly one day, so a gap in the record is
visible rather than plausible. Every day is a group, including a day that only
bumped the version or did work a reader cannot see. That day still carries a
codename and a single plain line that says as much.

## The shape of an entry

One `##` heading per day carries the codename, then two lines of metadata, a
lead line, and the bullets:

    ## The Viewer
    version: 0.131 - 0.176
    date: 12 August 2026

    - **Open one thing as big as the window will allow.** Documents and PDFs
      open properly, and the phone stopped copying the desk.
    - [new] **A PDF opens page by page,** so a long one starts reading before
      the whole file has been parsed.
    - [fix] **The note composer drew its sheet off to the left.** It sits under
      the card it belongs to now.

`version:` is the span of commit numbers the day covers. `date:` is the single
day the group's commits fall on, as `13 August 2026` - a group is one day, so
the date is one date.

Three things make the bullets read like the rest of the site. Keep all three.

**A lead line opens every group.** One untagged bullet in bold says, in a
sentence, what the day is for. A reader who stops there already knows whether it
matters to them. The bullets under it are the detail.

**Bold the thing each bullet is about.** The feature, the format or the part of
the app that changed goes in `**bold**` at the front, so a reader skimming the
bold runs reads the day as a list of what moved.

**Group a busy day under `###` subheads.** Once a day touches three or four
unrelated areas, a flat list of ten bullets is a wall. Break it into named parts
- `### The Timeline`, `### The picture viewer` - each a short run of bullets on
one theme. A quiet day needs none.

## Codenames

Every group carries one, a quiet day included. One to three words, Title Case,
punchy and plain, tied to the headline change - `The Viewer`, `Both Hands`,
`Off This Machine`, `Face Up`. Never reuse a name. Save the boldest for a
crowned milestone.

## The three tags

`[new]`, `[fix]` and `[faster]` lead a bullet, and there are only three on
purpose: a set that grows past what the eye tells apart at a glance is a legend,
and nobody reads a legend on a changelog.

- `[new]` - a feature or a capability that was not there before.
- `[fix]` - a repair to something that was meant to work and did not.
- `[faster]` - a speed-up or a size cut somebody could feel.

A bullet with no tag is prose about the day as a whole: the lead line, or a
housekeeping note. Lead a housekeeping note with its own bold phrase -
**`Maintenance:`** for internal work a reader should see named rather than spun,
**`Credit where it is due:`** for a borrowed idea or a vendored library.

## Tone

Written for somebody who uses the app and does not read the code. Say what is
different for them, not what was refactored. Lead with the benefit. Keep
sentences short, concrete and calm. Be honest: a trivial or internal day gets a
plain `Maintenance` line, not spin.

British spelling, to match the rest of the app: colour, organise, centre. The
one place American spelling is allowed is inside backticks, where a label is
quoted as it appears on screen - the button really does say `Optimize`.

## Marks and links

Use `**bold**` for the thing a bullet is about, `_word_` for the one
accent-coloured word, and backticks for a literal string from the interface. A
bullet may wrap: an indented line continues the one above it, folded with a
single space, and the page picks its own line breaks from the width it is read
at.

Separators are ` - `, a spaced hyphen. Bullets do not link out: name a feature
in bold rather than linking it. The only links the page carries are its own way
back to the board.

## Do not

- Do not use an em-dash or an emoji; the whole repository is em-dash-free on
  purpose.
- Do not leave a commit out of a day, or let the newest group disagree with
  `VERSION` in version.js.
- Do not hand-edit `web/patch.html`; it is generated. Write here, then run
  `node tools/gen-patch-page.mjs`.
- Do not fill the page with work a reader cannot see. The long record, internal
  work included, lives in `research/patch-notes-full.md`.

## Releases

## Flat Top
version: 0.690 - 0.702
date: 9 October 2026

- **`Rearrange` under the title card gets a proper top edge.**
- [fix] **With `Keep cards below the title card` on, a spiral or a scatter is a
  circle with its top cut flat.** The first row of cards sits level under the
  title, rather than the block hanging from a single card at its point.
- **Maintenance:** a round of tidying inside the app, with nothing to see.

## Boards Within
version: 0.648 - 0.689
date: 7 October 2026

- **A board can hold boards of its own,** and the files of other tools come in:
  Obsidian's canvases, PureRef's scenes, and an export that looks like the
  board.

### Boards inside boards
- [new] **`New board inside` makes a board within this one.** It sits on the
  board as a card showing it small, and opens on a double-click or `Enter`.
  `Up a level` (`Alt+Shift+Up`) comes back out, and each level keeps its own
  view and its own undo.
- [new] **A trail of the boards above the one on screen,** each a button. On a
  phone the one above sits behind an arrow, and `Back` in the browser, on a
  phone and in the apps comes up a level.
- [new] **Cards move between boards.** Hold a dragged card over a board card to
  send it inside, or use `Put in a new board`, `Move into` and `Move up a
  level` from its menu, each one undo. A duplicated, pasted or merged board card
  copies the boards inside it.
- [new] **A board inside another wears the look of the one holding it** until a
  choice in its own Look panel makes the look its own. A box puts it back.
- **The board file can now carry boards inside it.** A copy of the app from
  before today refuses such a file rather than opening it with pieces missing.

### Bringing work in and out
- [new] **JSON Canvas, the format Obsidian's canvases use, both ways.** A
  dropped `.canvas` comes in as notes, pictures, links, fences and connections,
  finding its files among those dropped with it, and `Save as JSON Canvas`
  writes the board out with its files in a zip.
- [new] **PureRef files come in.** A dropped `.pur` lands as its pictures where
  PureRef had them, sized, turned, cropped and mirrored, with its text as notes.
- [new] **`Save SVG`:** the board as a file whose cards stay text, and sharp at
  any size, when a browser opens it.
- [fix] **`Save image` and `Save PDF` look like the board** at every whimsy
  level, in every browser and both apps.
- [new] **Starter boards beside the example board:** a moodboard, a character
  sheet, a project brief and a reference grid, each a board of titled fences to
  fill.

### Finding and getting around
- [new] **Find takes colour words** - red, blue, grey, a hex code, and dark,
  light, pastel, muted, warm and cool, alone or together - and finds the
  swatches and pictures with that colour in them.
- [new] **`Alt` and an arrow move to the next card that way** and say which it
  is. The plain arrows still nudge.
- [new] **`Earlier versions` on the shelf opens an older copy of a board** as a
  board of its own. The apps keep ten a board, and the web keeps five while it
  is edited, one every fifteen minutes.
- [fix] **`Rearrange` with the title card kept on top** hangs the cards in a
  centred block under it, rather than bending round it with a gap above.

### Everything else
- [new] **Colourblind mode, under System,** redraws the interface's colours for
  deuteranopia, protanopia or tritanopia, names the colour of every swatch, and
  can show the board as each kind of vision sees it.
- [new] **Serbian and Macedonian Cyrillic set in the app's own type,** with
  their own italic letters in notes, names, the board title and the masthead.
- [fix] **A mouse wheel on Linux zooms however slowly it is turned.**
- [fix] **Changing the whimsy into or out of Harsh is one undo,** and toggling
  it back and forth no longer piles up steps on the Timeline.
- [new] **A YouTube or Spotify card asks for its title and cover only once you
  press play,** never just because it was drawn.
- [new] **`Check for updates automatically` in the apps,** on by default, with
  Help's check working either way.
- [faster] **The Android app is smaller,** and its backup leaves out a
  downloaded update.
- [new] **Credits says why the app exists,** and lists what it is made with as a
  block each that opens on its source, licence and maker. Several can be open
  at once.
- [new] **The privacy page wears your look,** the whimsy level and the dark
  sheet both, as the patch notes do.
- **Drawing is held back for now.** A pen, a highlighter and an eraser were
  built today, behind `Enable drawing` in the Debug fold until they are ready.

## Front Door
version: 0.646 - 0.647
date: 6 October 2026

- **Nothing in the app changed.** The project's page on GitHub now speaks to
  people using mbrd, with where to download the apps at the top.

## Open Book
version: 0.600 - 0.645
date: 5 October 2026

- **A long evening of menus that offer the next step,** a LaTeX editor, a
  search over every command, and a board that explains the app.

### The board
- [new] **`S` opens a search over every command** at the pointer, the
  selection's own first. `Move to a point` puts the view on an x and y.
- [new] **Nudge, Fit to contents and Fence from the menus:** nudge just the
  selected cards or one fence, fit a fence to what it holds, fence a single
  card, and `Gather and fence` cards too far apart.
- [new] **More ways to select:** by the same tags, by any one tag, more like
  these, and `Invert selection`.
- [new] **The Join tool has a flyout** to join the selected, join everything,
  or remove connections.
- [new] **`Alt`+drag leaves the original and carries a copy,** and on a stuck
  note it takes the note off its card.
- [new] **Align, Distribute and Same size bring the notes stuck to the cards,**
  measure from an anchored card, and grow the fence a card would leave.
- [new] **A fence that moves carries the anchored cards inside it.**
- [fix] **Dropped and pasted files and links land clear of the cards already
  there,** and so do cards put back from the bin.
- [new] **A tap on a binned card puts it back,** and `Restore all` empties the
  bin onto the board.
- [new] **A merged board's cards come in selected,** and dropping several board
  files offers to merge each.
- [new] **Your boards have a right-click menu** with `Duplicate board`, and a
  web board offers to save a copy before it is deleted.
- [new] **Delete says what it deleted, with an `Undo`.**
- [new] **A timeline step's menu can select what it changed,** and zoom to it.
- [fix] **A card's caption keeps its extension in view** however long the name.
- [fix] **A scroll-wheel notch zooms at once again** rather than gliding.

### Motion
- [new] **Selection rings lift with their cards,** the viewer closes back into
  its card, and the note composer flies from and to its note.
- [new] **With reduced motion on, things fade** rather than slide.
- [fix] **On Softish a dragged card is put straight down** rather than sinking
  past its place and bouncing back.

### Viewer and darkroom
- [new] **The viewer has a `⋯` menu,** or a press and hold, with `Edit picture`
  and a delete that shows the next.
- [new] **`Open these` looks through just the selection.**
- [fix] **A zoomed picture in the viewer pans in Firefox again.**
- [new] **Darkroom crop shapes** Original, 1:1, 4:5 and 16:9 hold while you
  drag, and `Shift` keeps the frame's shape. Closing with edits not applied asks
  first.
- [fix] **One darkroom `Apply` is one undo step,** however much it changed.

### Text and documents
- [new] **A LaTeX editor:** a `.tex` opens beside a live preview, with an
  Insert menu of snippets and `New LaTeX document` under More tools. Maths is
  typeset there and in Markdown.
- [new] **Markdown reads Obsidian's:** wikilinks, embeds, highlights, callouts,
  tags, footnotes, properties and more, and the editor keeps them all.
- [new] **The text editor zooms its page,** from the status bar or with
  `Ctrl`+wheel, and remembers it.

### Keeping your work
- [new] **An example board explains the app with a tour of its own.** Help >
  Take the Tour plays it.
- [new] **On the web a new version loads itself at a quiet moment,** the board
  stored first.
- [new] **The apps keep rolling backups of every board,** the newest ten, and
  a board whose page crashes reloads itself and says so.
- [new] **A second tab on the same board says its changes are not kept** until
  the first closes, then takes over. A failed save is tried again.
- [new] **`Report a problem`** copies the version, browser and last errors,
  sends nothing, and opens the issues page to paste them into.
- [new] **The board is one Tab stop:** `Tab` and `Shift+Tab` step through the
  cards in reading order and say what each is.
- [new] **The About sheet says which mbrd this is,** its licence and where its
  source is, and the privacy page names every place the app connects to.

## Second Try
version: 0.597 - 0.599
date: 5 October 2026

- **A picture that arrived as a plain card can be tried again.**

- [new] **A picture the browser could not draw when it arrived** - a HEIC, a
  camera RAW, or one you said no to at the size warning - lands as a card with
  its name and format, and that card now carries a `Retry` button. One press
  reads the file again: if it can be drawn now, the card becomes the picture
  and keeps its place, width, name and tags. If it still cannot, the card stays
  as it was and says so. `Undo` turns it back into the plain card.

## Elbow Room
version: 0.586 - 0.596
date: 3 October 2026

- **Room to work: a board can push its cards apart, and selecting on a phone
  stops fighting the finger.**

### On the board
- [new] **`Nudge board` pushes overlapping cards apart** by as little as it
  takes and keeps the board's shape. It is on the board's right-click menu and
  beside `Rearrange everything` in the sidebar. Anchored cards stay put, stuck
  notes ride along, and a fence too small for its cards grows to hold them.
- [new] **A click on a fence's body picks the fence.** A drag across it still
  pans or draws a band, and with something already picked the click only puts
  that down.
- [new] **Every board in the list has a picture,** a board made on another
  machine, a new board and a fresh install included. The board file now carries
  its own small picture, and a copy of the app from before today simply does
  not show it.
- [fix] **The sidebar's scrollbar stays up on every tab.**

### Sharpness
- [new] **At `Full`, pictures stay sharp down to 20% and sharpen as you zoom**
  rather than when you let go, with a mouse or trackpad. A touch screen keeps
  sharpening on release, so a pinch stays smooth.
- [fix] **A photo zoomed in close no longer blinks blank** while its full-size
  original decodes. The smaller copy stays up until the original is ready.

### On a phone
- [new] **With a card picked, holding a second one starts a group** instead of
  opening the menu, and a drag on bare board pans without dropping the group.
  Only a tap puts it down. In this mode a tap on a card's controls picks the
  card rather than playing it or following its link.
- [faster] **The crop frame drags about twice as smoothly.**
- [fix] **A fingertip no longer resizes a small card by accident.** Under a
  finger, the corners stop resizing below 30% zoom and the press moves the card
  instead. A mouse keeps 15%.

## Small Mercies
version: 0.553 - 0.585
date: 2 October 2026

- **Thirty small things that should already have worked.** Keys for the tools,
  undo that says what it did, copies that survive a change of board, and files
  you can get back out.

### Keys
- [new] **`Escape` during a drag puts the cards back** where they started and
  records nothing.
- [new] **`?` opens the keyboard shortcuts.**
- [new] **`Shift` keeps a dragged card on one line,** `Shift+F` frames the
  selection, and `1` zooms to 100%.
- [new] **Keys for the tools that had none:** `N` writes a note at the
  pointer, `J` turns Join on and off, `L` anchors or lets go, `]` and `[` bring
  to front and send to back, and `Ctrl+G` fences the selection.
- [new] **The Menu key and `Shift+F10` open the menu a right-click would.**
- [new] **`Ctrl+F` opens Find on the board,** which now opens on your last
  search and can select every match at once with `Shift+Enter`.
- [fix] **A held arrow key is one undo step,** not one per press.

### Picking and editing
- [new] **A note's colour can be changed after it is written,** from its menu.
- [new] **A `Select` fold on the card menu** picks every card of the same kind,
  everything in a fence, or every card joined to this one.
- [new] **The selected cards' connections can be removed in one step.**
- [new] **`Same width` and `Same height`** under Align & distribute size the
  selection to the card you opened the menu on. A picture keeps its shape.
- [new] **Duplicate, copy and cut bring what goes with a card:** the notes stuck
  on it, a fence's contents, and the lines between them.
- [new] **A copy made on one board pastes on the next,** pictures and all.
- [new] **The viewer steps to the previous and next item** with the arrow keys,
  two buttons at its edges, or a swipe. `Enter` opens the picked card.

### Undo and messages
- [new] **Undo and Redo say what they just did,** beside the buttons.
- [new] **Large changes carry an `Undo` on their message:** a cut to the bin,
  a join, removed connections and a rearrange.
- [new] **A message that asks for something carries the button for it** -
  `Reload` on a new version, `Export`, `Connect`, `Create tour` - and stays up
  while your pointer or keyboard is on it.
- [new] **The import summary names the files that failed,** or offers `Show
  them` when every new card landed off screen.

### Files and saving
- [new] **A card's own file can be saved,** from its menu or the viewer, under
  the name it arrived with. On a phone it can be sent to another app.
- [new] **`Replace file…` swaps the file a card holds** and keeps the card: its
  place, width, tags and every line and tour stop that names it.
- [new] **A card whose file is missing says so** with a dashed edge, and mends
  itself when the file is dropped back in.
- [new] **`Save image` and `Save PDF` can take only the selection,** or one
  fence.
- [fix] **A full web shelf asks before it deletes a board to make room,** and
  offers to save a copy first. It used to drop the oldest board silently.
- [fix] **When the browser stops storing the board, the corner says so** with a
  standing `Not saved - Export` button until it resumes.
- [fix] **Cloud sync waits out an offline spell** and pushes again when the
  connection is back, instead of stopping.

### Around the app
- [new] **Media keys, a headset and the lock screen control the board's music,**
  with the track's title and cover shown by the system.
- [new] **A YouTube link keeps its timestamp,** and `music.youtube.com` links
  play.
- [new] **The browser tab carries the board's name.**
- [fix] **The phone's Back button closes the open menu or dialog first** in the
  browser and the installed web app, as it already did in the Android app.
- [fix] **Focus follows the sidebar in and out** from the keyboard.

## Paperwork
version: 0.552
date: 30 September 2026

- **Maintenance:** nothing a reader would see. The save script gained two
  quicker modes.

## In Motion
version: 0.540 - 0.551
date: 24 September 2026

- **Things move the way they should: from where they start, without swinging,
  and not at all when you asked for less motion.**

- [new] **A picture opened from a card flies out of the card** rather than
  swelling from the middle of the screen.
- [new] **`Rearrange` slides the cards to their new places** rather than
  jumping them there.
- [new] **The Timeline slides in and out,** and what sits along the foot of the
  window moves with it.
- [fix] **Zoom steps pressed during a zoom add up** rather than restarting, and a
  jump to a card no longer swings outward before it lands.
- [fix] **Reduced motion now reaches every animation,** the document flights and
  the zooms included.
- [fix] **A submenu stays open while the pointer cuts diagonally across the rows
  above it,** and menus opened from the keyboard no longer pop.
- [fix] **A finger passing over a card no longer lifts it.**
- [fix] **In the desktop app, a title-bar menu drops from its title** with a
  light shadow of its own.
- **Maintenance:** a benchmark built into the app, for measuring zooms and pans
  on a given machine.

## No Dead Weight
version: 0.487 - 0.539
date: 23 September 2026

- **A board file stops growing on every save, and a phone keeps up with a
  zoom.** The rest of the day went on the text editor, most of it on a phone.

### Board files
- [fix] **Saving a board opened from its file no longer writes its pictures
  twice.** A 388 MB board opened on a phone grew to 653 MB on its first save.
  The same save now adds 53 KB.
- [fix] **The history stops leaving a dead copy of itself in the file.** It is
  kept in pieces of 500 steps, and a save rewrites only the last piece. Once
  enough of the file is dead, it is written whole again at a quiet moment:
  after a minute with no edit, as the app closes, or on `Save`.
- A board saved now opens in an older copy of the app with its history marked
  out of date. The board itself opens whole.

### On a phone
- [faster] **A zoom in on a phone runs at three times the frame rate,** 56
  frames a second where it was 17, and a zoom out no longer blinks the board.
- [fix] **Cards stop vanishing for a moment as you zoom out from far in.**
- [faster] **A zoom out through 25% no longer stutters,** and a zoom near 35%
  no longer stalls. The photographs change to their small copies on the frame
  the zoom crosses, not after it stops.
- [fix] **A long pan no longer fills the phone's memory.** Every card the board
  put away as it left the screen stayed in memory, and a few minutes of panning
  held thousands of them.
- [faster] **The grid's dots cost a fraction of what they did** at `Softish` and
  `Middle`, so a zoom on a fast phone drops about a third fewer frames.
- [faster] **A board opens faster at `Full` and `Balanced`.** A photograph is no
  longer copied again at every start, and one only a little larger than the
  sharpness limit is shown as it is. A board of 70 photographs spent 4.2 seconds
  on decoding as it opened, and now spends half a second.
- [faster] **A pan or a card drag starts without a hitch,** where the first
  press restyled every card on the board.

### The text editor
- [new] **The page rises in from below as the editor opens,** and tips and drops
  away as it closes.
- [new] **On a phone, every tool sits in two rows at the top of the screen,**
  clear of the keyboard, with the word count and a running session's time above
  them. The page runs from one edge of the screen to the other.
- [new] **A narrow window folds the ribbon rather than scrolling it.** The
  styles become one button, Vomit Mode another, and the small commands lose
  their words.
- [new] **A document may be untitled.** Clear its name on the sheet, and the
  card reads `untitled`.
- [new] **A sticky that grew into a document turns back into a sticky** if you
  cut the text back down to fit while the editor is still open. The note opens
  with the caret where you deleted.
- [fix] **The sheet no longer jumps sideways** as a scrollbar arrives.
- [new] **A document written back down to fit flies back into its sticky,**
  and a sticky outgrowing itself hands over to its page without a jump.
- [fix] **A long sticky scrolls inside the composer** rather than running off
  the bottom of the window, and the count of what is left shows only in its
  last ten characters.
- [fix] **A paste with a button or a dialog focused no longer lands on the board
  behind it** as a stray `.md` card.

### Around the app
- [new] **The version at the foot of the sidebar links to these notes,** beside
  a new `Privacy` link.
- [new] **The browser's install prompt shows two pictures of the app,** where it
  had none.
- [new] **Archive and folder cards are drawn as folders,** with a look of their
  own at each whimsy tier.
- [fix] **Signing in to Drive on the web finishes** on a host that drops `.html`
  from the address, and the app starts offline again.
- [fix] **A board pulled from the cloud keeps its look, settings and history.**
- [fix] **Over a hundred smaller repairs** from a full read of the code, most of
  them the readers for unusual file formats refusing a broken file rather than
  stalling on it.

## The Blank Page
version: 0.465 - 0.486
date: 22 September 2026

- **mbrd writes documents now.** A text file opens in a word processor of its
  own, and a sticky that runs long grows into one.

### The text editor
- [new] **`Edit` opens a `.md`, `.txt` or `.fountain` in the text editor,** a
  sheet of paper on a desk across the whole window. The ribbon holds undo, the
  marks, the paragraph styles, the lists, find and replace, and an outline down
  the left. The foot counts the words. A file you open and close unchanged is
  never rewritten.
- [new] **The name at the head of the sheet is the document's name,** and a
  change there renames the card.
- [new] **A sticky typed past 120 characters becomes a `.md` document** and
  grows open into the editor at the caret. Not a keystroke is lost on the way.
- [new] **_Vomit Mode_ keeps you writing forward.** Pick a time from 5 to 60
  minutes, and everything before the word you are typing is locked until the
  time runs out. Backspace works inside the current word and no further.
  `Super` locks that word too, 10 seconds after your last key.
- [new] **A `.fountain` screenplay opens in screen mode,** on the standard page
  in Courier. It types like a screenwriting tool: `int. ` starts a scene
  heading, a name in capitals is followed by dialogue, and Tab changes the
  element. The foot estimates the pages and the scenes.
- [new] **The editor has its own right-click menu.** Shift and right-click still
  gives the browser's, with its spelling suggestions.
- [new] **A double-click still opens a document to read.** The text sits on a
  page as tall as the window and wraps to it. Turn on `ASCII art` in the editor,
  and its lines keep their length.
- **Credit where it is due:** Vomit Mode is after vomitdraft.com.

### Around the board
- [fix] **A mouse wheel on Linux zooms again,** where Chromium's finer steps
  read as a touchpad and panned the board. `Mouse wheel` gains
  `Always zooms, touchpad too`, and a window coming back into focus no longer
  jumps its zoom.
- [new] **A link to mbrd shows a new preview picture** in chat apps. It is a
  tenth of the old size, small enough for WhatsApp to show it.

## Print Ready
version: 0.439 - 0.464
date: 21 September 2026

- **An exported picture is sharp enough to print, and a sticky styles its words
  one at a time.**

### Exporting
- [new] **`Save image` and `Save PDF` ask first.** Set the detail in ppi and see
  the pixel size it comes to, the JPEG quality, a margin in millimetres, and
  which of the joining lines, the sheet outline, the grid and the paper texture
  go in. A preview beside the options redraws as you change them.
- [new] **An export is drawn at 300 ppi by default,** so an A4 sheet comes out
  2480 x 3508, and a PDF page is the board's real size. The JPEG keeps its full
  colour detail, where the browser's own encoder blurs the colour at every
  quality.
- [fix] **An export carries the board's own paper texture and its shadows,**
  where it had a speckle like static and no shadows at all. `Shadows` and
  `Card tilt` switch them, and a tilted card has clean edges.
- [fix] **The title card exports with its name on it,** where it was an empty
  box.

### Sticky notes
- [new] **A sticky styles its words, not its lines.** Title, font and highlight
  apply to the words you select, or to what you type next. The highlight is a
  pen, with the colour at the caret under it. Copy and paste between notes
  keeps the styles.
- [new] **The composer shows the note exactly as it lands on the board,**
  magnified, with the words wrapping where they will. A new note starts larger,
  at 160px square, and its type is a step smaller.
- [new] **A sticky holds 120 characters.** The counter sits in the note's corner
  and goes red at twenty left. Past the limit it says the note becomes a `.md`
  file, and closing the editor makes it one, as one undo step.
- [fix] **Select all and then paste in a sticky keeps the paste,** where the
  text went and nothing replaced it.
- [fix] **Switching to another window no longer closes the note you are
  writing.**

### On a phone
- [fix] **The Android app saves its board files again.** A save failed on every
  board from 0.404 on.
- [fix] **`Check for updates` on the phone always answers.** It says it is
  checking the moment you press it, says so if the check fails, and answers
  when the update is already downloaded.

### Around the board
- [fix] **The corner marks of a selection stay visible past about 160% zoom,**
  where they thinned down to the ring and vanished.

## From the Camera
version: 0.415 - 0.438
date: 20 September 2026

- **A photograph draws on the board whatever the camera saved it as.** iPhone
  HEICs and camera RAWs are turned into pictures as they land, and the cards
  that used to arrive grey and nameless arrive as what they are.

### Photographs
- [new] **A `.heic` or `.heif` from an iPhone arrives as the picture.** The file
  is read here and the picture inside it decoded by the machine's own decoder,
  about a fifth of a second for a twelve-megapixel one. Where that decoder is
  missing, a slower one is fetched instead, so the same file draws on every
  browser and at every address. A picture the phone stored as a grid of tiles
  comes back whole and the right way up.
- [new] **A camera RAW that baked no preview is developed as it arrives,** so a
  night shot saved as a `.dng` is a photograph rather than a grey card - and
  `Demosaic`, which is offered only on a photograph, is there to develop every
  pixel of it when you want that.
- [new] **The file you dropped is kept beside the picture,** untouched, and
  `Optimize` is the one thing that throws it away.
- [faster] **`Optimize` shrinks a HEIC,** where it used to count one and then
  quietly walk past it - often the largest file on a board made on a phone.
- [fix] **`Edit picture` opens on a HEIC or a RAW from an older board,** where
  it opened on a blank sheet.

### Around the board
- [fix] **`Play` keeps the board in frame as it replays,** so a history that
  builds a board up is watched rather than happening off the edge of the window.
- [fix] **Saving a board in Samsung Internet no longer leaves an empty file.**
  Where the browser offers to save and then refuses to write, the board comes
  down as an ordinary download instead.
- [new] **`What this board weighs` says where every file is held** - on the
  board, in the drawer or in the history - as well as what it all comes to.
- [fix] **The credits scroll inside their own sheet,** which keeps its corners.
- **Maintenance:** a release carries Windows and Android. A macOS or Linux copy
  sees the new version and waits for the next full release, which updates it
  straight there.

## Steady Hands
version: 0.413 - 0.414
date: 19 September 2026

- **A board on a phone stopped flickering.** Three separate faults made cards
  vanish and come back, and all three are gone.
- [fix] **Cards no longer disappear while the board is zoomed out,** where a
  screenful of them could go at once and return on the next touch.
- [fix] **`Light` stopped reloading the board as you pan.** Cards dropped out
  and drew again as the board moved, at that stop and at no other.
- [faster] **A pinch costs about half of what it did,** so the board keeps up
  with your fingers. A GIF frozen at far zoom no longer stalls the gesture
  either.
- [new] **The title card, once thrown away, comes back from the Drawer's
  `Special` shelf** rather than from a button in the Drawer's header.
- [fix] **The waiting strip sits under the panels and the menus.** An import
  runs for as long as it runs, and it stopped covering whatever you opened while
  it did.

## The Other Button
version: 0.409 - 0.412
date: 18 September 2026

- **A right-click says the same thing everywhere: do something to this.** The
  Timeline, the player and the toolbar answer it now, and the joining lines were
  redrawn.
- [new] **Right-click a step on the Timeline** for the ways to it and through
  it: go there, change its rule, name it, delete it. Right-click anywhere else
  on the bar for the gear's own rows. Any mark can be named now, not only the
  point the board is standing on.
- [new] **`Delete N steps after this point`** in the gear clears the history in
  front of the marker and leaves the board exactly as it is.
- [new] **Right-click the player** for its buttons as rows, and a mute the bar
  has no room for.
- [new] **Right-click a tool in the toolbar** to open its flyout at once.
- [fix] **A joining line no longer lies along the card it leaves.** It keeps a
  short straight at each end, and a small sideways step is drawn as one S rather
  than two corners.
- [fix] **The board takes the Timeline's band while the bar is faded** and is
  held still as it does, so nothing slides half a band each way.

## Indoor Work
version: 0.406 - 0.408
date: 17 September 2026

- **Nothing a reader would notice** - a day of work inside the app.

## Files and Light
version: 0.404 - 0.405
date: 16 September 2026

- **On the phone every board became a file, and `Light` became light.**
- [new] **The Android app keeps each board as a file in the board folder,** as
  the desktop does: the list reads the folder, `New` makes a file, a rename
  renames it, and `Delete` moves it to a bin that keeps it thirty days. The
  autosave writes the board to its own file a few seconds after an edit and
  again when the app goes away, adding only what changed.
- [faster] **A large board opens and saves on a phone that could not hold it
  before.** A 400 MB board no longer has to fit in the page twice over.
- [faster] **`Light` is finally lighter on a phone.** The paper texture comes off
  the page, and a photograph you zoom right into draws at once rather than
  stalling and flashing white first. Those were the two heaviest things on a
  board and the dial could reach neither.
- [faster] **A pan is smoother on a phone,** with two rounds of work a frame
  taken out of it that nobody could see anyway.
- [fix] **An update says so where you are looking.** The offer arrives as a note
  with its own button as well as sitting at the top of the Board tab.

## Past the Edge
version: 0.403
date: 15 September 2026

- **A drag that reaches the edge of the window carries the board with it,** and
  the toolbar learned to change size without jumping.

### Carrying things
- [new] **Drag a card, a band or a corner to the edge of the window and the
  board pans under it,** so a card can be carried past what the window shows. It
  starts slowly and picks up the further in you push, and a shape dragged off
  the sticker pad or a card out of the drawer pans the same way.
- [new] **The resize grips go at 15%,** and the ring says so: from there down a
  card is carried rather than sized, and a grip that small covered more of the
  card than the card showed.
- [new] **A right-click inside a fence opens the fence's own menu,** and a fence
  resized on a snapped board puts what it carries back on the grid.

### The look
- [new] **The toolbar moves between its sizes rather than snapping,** as a panel
  opens or the window narrows, each tool gliding from where it was and a word
  fading in behind the movement.
- [fix] **With animations off, nothing strobes.** The splash, the waiting bar,
  the darkroom and the player's bars each hold a frame worth holding, where a
  stopped loop used to flash.
- [fix] **Card shadows reach the Feed at `Balanced`,** where its tiles stayed
  flat and the switch did nothing.
- [fix] **A slider on a phone keeps its name and its value** on a card of its
  own while your finger is on it, over the board it is changing.
- [fix] **Photographs stopped blinking at `Light` while you zoom,** where every
  card was being swapped to a thumbnail and back.
- [fix] **The drawer builds its cards ahead of the scroll at every stop,** so
  they stop popping in and out on the device least able to afford the rebuilds.

### Around the app
- [new] **`Get the app` opens the latest release** in a new tab, where the apps
  and their notes live. The download page it used to open is gone.

## Unpacked
version: 0.318 - 0.402
date: 14 September 2026

- **An archive drops in as one card you can open, the Timeline moved to the foot
  of the window, and the tour, the fences and the apps' updates were reworked.**
  The rest of the day went on a long list of rough edges.

### Archives and folders
- [new] **A ZIP, TAR, 7z, RAR or `.gz` arrives as one card with an `Unzip`
  button.** A press puts what was inside on the board in a spiral round where the
  card sat, in the archive's own order, and one undo takes it back. A folder
  inside becomes a card with an `Open` button, which does the same one level down.
- [new] **A folder dragged in from Explorer or Finder still spreads its files over
  the board,** but each folder inside it lands as one folder card rather than a
  flood of loose files.

### The Timeline
- [new] **The Timeline is a bar along the foot of the window,** the way a history
  bar sits under a CAD drawing. It takes its own room rather than covering the
  board, starts on at a desk and off on a phone, and keeps your choice.
- [new] **The bar is a row of steps with a playhead you drag,** and the board
  follows it. `Play` walks forward from where you are, the arrow keys go one step
  at a time, and a gear holds naming, trimming and `Hide timeline`. The
  `Show timeline` box in the Board tab brings it back.
- [fix] **Going back and forth in the Timeline no longer loses changes that were
  never steps,** such as the board's title or a setting.
- [fix] **Stepping through the Timeline redraws a card whose look changed,** such
  as a note set to `Low opacity`, where it kept the look it had.
- [fix] **`Play` lines up with the sidebar's edge,** its triangle sits in the
  middle of the button, and the gear has the outline and ground of a button.
- [new] **While `Play` runs, the board is there to watch.** A press pans, the tools
  that would change it are dimmed, and a drop or a paste is turned away with a
  note that says to press `Pause`. Only `Pause` stops a replay, where any press
  on the page used to.
- [new] **`Delete timeline` in the gear** clears the whole history after asking.
  The board as it stands becomes the start, and the board itself does not change.
- [fix] **A reload opens at the newest step,** where a board left after a few
  undos came back that many steps behind.
- [fix] **The steps scroll a whole step at a time,** so no mark is cut in half at
  either end of the bar, and the scrollbar and the wheel reach the oldest steps.

### The tour
- [new] **A board with no tour offers `Create tour`,** and `Take the tour` and
  `Edit the tour` appear once there is one. While you tour or edit, the cards stay
  where they are: a press picks, a drag pans, and pointing at a stop lights it and
  fades the rest.
- [new] **The tour bar has two rows,** the stop's name and caption over back,
  forward, the stop's own actions and close. A clip or song alone in a stop plays
  by itself, and the board's music pauses while you tour. `Delete` in the editor
  takes a stop off the tour, with `Undo` on the note that says so.

### Fences
- [new] **A fence can wear one of the four note colours, and roll up to its name
  bar.** Rolled up, the cards inside are hidden and out of reach until it rolls
  down again, and `Find` unrolls it when the card it finds is inside.
- [new] **A new fence anchors itself** ten seconds after you last move it. The
  anchor and pin badges on a card are buttons now: a press on the anchor lets the
  card go, and a press on the pin lets the note come away.
- [new] **On the Feed, a fence's name heads its own cards,** and fences and loose
  cards take turns in the board's order rather than every loose card falling to
  the end.

### Around the board
- [new] **`Demosaic` develops a camera RAW from its sensor,** where the card had
  shown only the small preview the camera tucked inside. Undo puts the preview
  back, and `Optimize` develops a RAW before it shrinks it.
- [new] **A Word file with no picture of itself shows its first page,** set from
  its own text, headings, pictures and tables.
- [new] **The style tile shows eight named swatches,** and a click on one copies
  its hex code.
- [new] **The Playlist button turns up once there has been music on the board,**
  and the first song you drop opens the player. It stays off the bar while a video
  plays.
- [fix] **`Picture sharpness` decides again.** Above `Soft`, a photograph draws at
  the size the dial asks for rather than at the light display copy.
- [fix] **The interface sounds start switched off.** They are experimental, so
  they wait until you turn them on, and everybody was set back to off once.
- [new] **A photo or video set to `Fit` takes the shape of its picture.** The card
  keeps its shorter side and the longer one follows the picture, in the same undo
  step as the switch, and a corner drag keeps that shape until you hold Shift.
- [new] **A sticky offers `Low opacity` where it offered `No card`.** The paper
  goes to 60% and the words stay solid, and the note comes back to full under the
  pointer or while you type in it. It is see-through at every whimsy tier, Harsh
  included, and below 40% zoom it is a whole note again.
- [new] **Holding Ctrl while you scroll moves the board up and down,** as Shift
  moves it across. A pinch on a touchpad still zooms.
- [fix] **A note's name no longer starts with `#`.** Find, the Timeline, the tour
  and a note seen from far out show its words without the heading mark.
- [fix] **Below 40% zoom the buttons on a card go** - the anchor and pin badges
  and the title card's pen and `T`. An audio card's play button fits inside the
  card, and one with cover art shows the art with the button over it.
- [new] **`Tilt cards` on the Look tab.** Switched off, every card stands square;
  a card you drag still tilts in your hand. It is on to begin with.
- [new] **A card wider than eight grid squares or taller than six rests
  straight,** and takes its own lean back when you make it smaller again.
- [fix] **A card lifts under the pointer by the same amount at every zoom,**
  where far out it jumped by most of its own height.
- [fix] **`Fit`, recentring and the zoom buttons centre in the room an open
  sidebar leaves,** rather than behind the panel.
- [fix] **Connection lines hold still while you carry a card.** Its own lines run
  straight, and everything is routed once when you put it down, where the whole
  board used to reroute each time your hand rested.
- [fix] **The close cross no longer shows a hole in its middle** in Firefox at
  Harsh.

### The sidebar and the toolbar
- [new] **Every dropdown in the sidebar is the app's own picker,** and the font
  pickers set each name in its own face. Any menu picks on a press, a drag and a
  release, the way a desktop menu does.
- [new] **The Board tab was sorted.** `Save` stands alone with `Save As` and
  `Export` under `More`, and a new `Other` section holds the tour, the Timeline
  and `Board contents`, where a video row now plays a silent preview on hover.
- [new] **The toolbar slides aside for an open panel** instead of vanishing, and
  drops its words, then tucks Colour, Link and Stickers behind `More`, as the room
  runs short.
- [new] **Opening or closing the sidebar pans the board by half its width,** so
  what you were looking at stays in sight. The Playlist moves over with it and
  centres in the room the panel leaves.
- [new] **The sidebar fills the screen only at 600 pixels wide or less,** where it
  did from 700. Between the two it stays a panel at the side, with the board
  beside it, and it no longer fades away while you drag one of its sliders.
- [new] **The header editor was tidied.** The font is the sidebar's own picker
  with `Default` at the top, the size reads in pixels and every step shows,
  `Line height` appears only while `Wrap long names` is on, and `Start over` is
  `Reset`. A new board keeps its name on one line.
- [fix] **The player and the buttons along the foot sit level with the
  sidebar,** 14 pixels off the bottom of the window.
- [new] **The Keys list draws every key as a keycap.**
- [fix] **The toolbar keeps up with a window being resized,** where it trailed
  behind and stepped after it.
- [fix] **The sidebar's shadow no longer darkens the Timeline** under it.

### The look
- [new] **Corners travel when the whimsy dial moves.** Every corner on screen
  eases into its new shape along with the colours, rather than jumping, and into
  Harsh they go quicker but still visibly.
- [fix] **Cards no longer pop up in place after a load or a change of look.**
  Their lift and lean travel as they should while the colours fade.
- [new] **The corners agree.** Panels that sat a couple of pixels rounder than
  their neighbours match now, and the sidebar wears the toolbar's corner, level
  with it along the top.
- [new] **Every button on the glass is square,** 42 pixels or 45 on a touch
  screen, the zoom control's three parts included. At Softish they are fully
  round, and at Harsh the badges, closes and pick circles are square.

### The Feed and the phone
- [new] **Every Feed tile looks like its card on the board** - style tiles, fonts
  and 3D models included - and a video plays in its tile with a tap.
- [new] **A press on the Feed's title opens the masthead editor,** and `Find`
  scrolls the Feed to what it found and rings it.
- [new] **Cards on the Feed can be selected.** A click with Ctrl, Shift or Cmd
  picks one, and on a phone a long press offers `Select multiple`, after which
  each tap picks one. The menu, `Delete` and `Tags` then act on them all.
- [new] **An audio tile on the Feed has its play button in the middle,** as a
  video tile does.
- [new] **Notes stuck on a card ride its tile on the Feed,** where each had a
  tile of its own somewhere else. A small sticky in the corner counts them, and a
  press lays them open over the card. `Find` on one of them opens its card's
  notes.
- [fix] **A picture set to `Fit` takes its own shape on the Feed,** tiles stand on
  a soft shadow at full quality, and on a phone the Feed runs edge to edge with
  `Find` at the top right.
- [fix] **The phone lost the controls that did nothing there** - key hints,
  `Reload board` and `Anchor` on a Feed tile, and the grid and spacing settings in
  the sidebar. An empty Playlist has a way back to the board.

### Sharing through Drive
- [new] **`Shared links` lists every board you have shared,** from any machine,
  each with `Copy link` and `Stop sharing`.
- [new] **A heavy board can be shared as a viewing copy,** with the photographs at
  display size, a still for each clip and no bin or history, when that comes out
  much smaller.
- [fix] **An upload that drops resumes from the last byte that arrived,** and a
  synced board stops leaving the files it no longer uses in your Drive.

### The desktop and Android apps
- [new] **An `Update` button on the title bar.** The app looks once a day, and a
  press on the button downloads the new version, counting as it goes, then
  installs it and restarts. A macOS or portable copy opens the download page
  instead, and `Check for updates` answers on the same button, not in a dialog.
- [new] **The Android app offers its update in a row at the top of the sidebar,**
  counting while it downloads. It looks once a day, waits when Data Saver says so,
  and opens no dialogs.
- [new] **An unsaved board shows a `*`** on the title bar and in the window title.
- [new] **A `.deb` for Debian and Ubuntu** beside the `.AppImage`, so a board opens
  on a double-click on Linux.
- [faster] **A desktop save writes only what changed** to the end of the board's
  file rather than the whole board, and a save cut short by a crash leaves the last
  good one readable.
- [fix] **The desktop app no longer crashes on its first start after an update.**
- [fix] **The Windows icon is back on the shortcuts and the taskbar,** and draws
  cleanly at small sizes.
- [fix] **Android's status and gesture bars stop flickering.** They are black in
  dark mode and white in light mode.
- [fix] **The apps hide the Google Drive rows** until signing in works there,
  rather than opening a sign-in that fails. A shared link still opens.

### Repairs
- [fix] **`New` while typing in a note no longer leaves the old board's cards
  behind.**
- [fix] **A ZIP made on Windows shows its file names as they were written,** where
  an older Windows encoding used to come out garbled.
- [fix] **A board saved by a newer mbrd keeps what this one does not know,** and a
  ZIP of some other kind is refused as `This is not an mbrd board`.
- [fix] **Three small ones:** an HEVC clip's poster is no longer black, the drop
  overlay goes when a drag leaves without dropping, and the viewer closes when
  another board opens.
- [faster] **Dragging a note across a busy board is lighter,** since it asks only
  the cards near it whether it should stick.
- **Credit where it is due:** the credits name what they had been missing - ONNX
  Runtime, u2netp, Geist Mono, the FFmpeg builds, Electron, sharp and Capacitor -
  libarchive.js, which opens 7z and RAR, and LibRaw, which develops a camera RAW.
- **Maintenance:** every gap in the stylesheets was put on one spacing rhythm, and
  the research notes were audited and tidied.

## Pocket Size
version: 0.304 - 0.317
date: 13 September 2026

- **mbrd is an Android app now,** the same board as the website and the desktop,
  and on the desktop every board became a file you can see.

### Android
- [new] **mbrd installs on Android 7 and later,** as an `.apk` from `/download`
  beside the desktop builds. It is the same app as the website, wrapped for a
  phone.
- [new] **Your boards live in `Documents/mbrd` on the phone,** so they show in
  Files and survive an uninstall. The app asks once, on a page that says why, and
  `Not now` keeps them inside the app until the next start.
- [new] **Files open in mbrd from other apps,** through Open with or Share. A board
  opens, a picture, clip, sound, PDF or text file lands as a card in the middle of
  the view, and a shared link becomes a link card.
- [new] **Back closes whatever is on top** - a menu, a dialog, a panel - and with
  nothing left open it puts the app in the background with the board kept. The
  board is written away whenever the phone pauses the app.
- [new] **Save asks for a name, and an export or a share goes through the phone's
  own Save dialog and share sheet.**
- [new] **The app installs its own updates** from the same releases as the
  desktop, on Android 12 and later without a confirm screen.

### The desktop
- [new] **Every desktop board is a file in `Documents/mbrd`.** `New` makes the file
  at once and the board on screen is written to it as you work. The board list
  shows the folder with an `Open folder` button, and Open and Save start there.
- [new] **The cross on a board in that folder moves the file to the bin,** where it
  can be restored. A board kept anywhere else only leaves the list.
- [fix] **`Cmd+Q` quits the macOS app.** It used to write the board away and then
  stop short of quitting.

## Well Connected
version: 0.297 - 0.303
date: 12 September 2026

- **The lines between cards were rebuilt, photos grew a lighter stand-in, and
  link cards say more.** A day spent on the board's plumbing.

### The lines between cards
- [new] **Connection lines were rebuilt.** A line leaves and arrives on whichever
  side of each card is nearest, finds its way around the cards between it with
  clean right-angled bends rather than a staircase, and wears the look of the
  whimsy dial. Several lines meeting one card fan across its edge instead of
  stacking, and a line you draw by dragging keeps the curve it had under your hand.
- [fix] **The "Cannot join" mark is gone.** The rebuilt router reaches a side of
  every card, so the round badge that used to pin over a card and announce the
  pairs it could not connect has nothing left to report.

### Photos and the Feed
- [new] **Every photo keeps a lighter display copy,** about a thousand pixels on
  its long side, which is what the board and the Feed now draw. An older board has
  the copies filled in the first time it opens.
- [new] **A card shows its full original when you zoom right in,** and drops back
  to the light copy when you zoom out - so a close look stays sharp without the
  whole board carrying full-size pictures.
- [faster] **The Feed keeps up on a big board.** It draws only the tiles in view
  and fills them in as you scroll, each picture set to fill or fit its tile rather
  than all of them decoded at once.

### Link cards
- [new] **Player and brand cards say more.** A card fetches the page's own title,
  names the Steam game or the Reddit community it points at, and shows the X logo
  where a link leads there.
- [new] **A link card's menu leads with `Edit` and `Copy link`,** and every link
  out of the app asks once before it takes you off the board.
- [fix] **A pasted player link arrives the right size,** at the least a player
  needs rather than the smaller default a plain link uses.

## Live Links
version: 0.295 - 0.296
date: 11 September 2026

- **A link card stopped being a title and a favicon,** and a Spotify link plays
  where it sits.
- [new] **A Spotify link plays on the board.** Paste a track, album or playlist
  and it becomes the real player in place, with the Spotify mark stretched across
  it.
- [new] **Every link card wears its site.** The site name fills the width of the
  card and its logo sits on the chip, so a wall of links reads as a wall of
  places rather than a column of addresses.

## Own Title Bar
version: 0.293 - 0.294
date: 8 September 2026

- **The desktop window draws its own title bar.**
- [new] **The desktop window draws its own title bar,** in the app's type and
  colours, carrying the name of the open board.
- **Maintenance:** the comments throughout the code were rewritten in plain,
  controlled English. Nothing on a board changed.

## Quiet Bump
version: 0.292
date: 7 September 2026

- **Nothing a reader would notice** - a version bump only.

## A Window of Its Own
version: 0.273 - 0.291
date: 6 September 2026

- **mbrd is an app you can install now.** The board in the browser is unchanged
  and is still the whole of it. What the desktop adds is a window of its own, your
  boards where you can see them, and three jobs a tab is not allowed to do.

### Installing
- [new] **mbrd installs on Windows, macOS and Linux.** One `Setup.exe` asks on a
  page of its own whether to install or to leave a portable copy, a `.dmg` for
  macOS and an `.AppImage` for Linux. `/download` has the three, and says plainly
  what your computer will say about an app nobody has paid to sign yet, and what to
  do about it.
- [new] **A `.mbrd` file opens by double-clicking it.** The title bar says which
  board is open, a menu bar carries the app's own commands, and a second file
  opens in the window already running rather than starting another.
- [new] **New versions arrive on their own and install when you quit.** A note
  says which version will install when you close the app, and then nothing happens
  until you do. A portable copy and an unsigned macOS build say they cannot replace
  themselves rather than offering a button that fails.

### What the desktop does that a tab cannot
- [new] **Your boards are a folder, not a browser's storage.** They sit in
  `%APPDATA%/mbrd` and its equivalents, and a portable copy keeps them in `data`
  beside the program. A browser may clear its own storage to make room; a folder
  stays where you put it.
- [new] **`Optimize` does video on the desktop.** It is the first thing this app
  can do there and cannot do in a tab. ffmpeg is a program sitting beside the app
  rather than a 32 MB download into a page.
- [faster] **`Remove background` is close to instant on the desktop** - 13
  milliseconds against a couple of seconds in a browser, once the model has loaded
  the first time.
- [new] **`Add files` offers every format mbrd knows** - twelve groups, from
  pictures and sound to 3D and CAD, archives, maps and disk images - where it had
  offered only the four kinds the app can draw.

## Off This Machine
version: 0.271 - 0.272
date: 2 September 2026

- **A board can be shared as a link, and kept in your own Google Drive.**
- [new] **`Share link` puts the board in your Drive and copies a link anybody can
  open.** `Keep this board` copies it to your account and keeps it up to date from
  then on, `Open from cloud` opens it on another machine, `Sync now` sends
  whatever has changed, and `Stop syncing` leaves the stored copy where it is.
- The app asks for the one permission that reaches files it put there itself, and
  for nothing else in your Drive.

## Even Edges
version: 0.266 - 0.270
date: 31 August 2026

- **A handful of repairs the audits had been carrying, and a Mobile board that
  resists at its edges.**
- [fix] **A Mobile board resists at its edges instead of stopping dead.** Dragged
  past the top it follows at a diminishing fraction of your finger and settles back
  when you let go.
- [fix] **The tour's chips and the timeline's marks are one shape,** where they
  had been two rows of small squares agreeing about nothing.
- [fix] **Two colours the tier work had left behind** are put right.
- **Maintenance:** two small repairs the audits had been carrying, and the
  research written up.

## Off Day
version: 0.265
date: 28 August 2026

- **Nothing a reader would notice** - a version bump only.

## Odd Hours
version: 0.264
date: 25 August 2026

- **Nothing a reader would notice** - a version bump only.

## Under the Hand
version: 0.258 - 0.263
date: 22 August 2026

- **Mostly a release about what the app does when you touch it:** a press that is
  answered, a menu that leaves the way it came, a board that steps back while you
  follow a thread across it. Two tools also stopped guessing, and the tour is
  built somewhere else entirely.

### Touch and menus
- [new] **Every button answers a press,** and a tapped one stops staying lit
  afterwards. On a touch screen the browser answers hover from the last tap and
  leaves it standing, so a tool pressed once looked chosen until something else
  was.
- [new] **Menus leave the way they arrive.** Find, the right-click menu, the
  toolbar's flyouts, the fence offer and the connection chip all used to appear and
  then simply vanish. Each plays its way out now, and a flyout opens from the
  middle of the button that opened it rather than from its corner.

### The tour, and following a thread
- [new] **The tour is built on the board.** Every card carries a small square in
  its corner - a number if it is at that stop, a `+` if it is not - and a bar along
  the foot holds the order and a caption for each stop. It used to be a list in a
  panel covering the third of the board you were picking cards from.
- [new] **Following a card's threads steps the rest of the board back.** Hovering a
  card used to drop every line that was not its own. The cards those lines reach
  stay as they are and everything else goes quiet - enough to separate, not enough
  to hide.
- [fix] **A connection finds its way around the cards between its ends,** where it
  used to settle on a side before looking and send a line behind a card.
- [fix] **The connect tool puts itself down after a pair,** with Shift keeping it
  up. It stayed armed before, which every first-time hand read as the app having
  got stuck.

### The two tools that stopped guessing
- [new] **`Remove background` finds the subject,** rather than filling inwards from
  the edges against their average colour. A card cut out this way is cut out in the
  exported picture too.
- [new] **CAD files draw properly.** `.iges` and `.igs` are read at all now, and
  they and `.step` go through a real CAD kernel rather than this app's own reading
  of their surfaces, so a curved part arrives curved.
- [fix] **A cut-out card stops growing its background back when you zoom out.**

## The Long Way Round
version: 0.253 - 0.257
date: 18 August 2026

- **A release with almost nothing new on it:** the app was read through twice for
  work it was doing twice over, and the result cleared.
- [fix] **The palette's photo count reads `Every photo` again** at the top of its
  range, where it had printed `120 photos`.
- [fix] **Sizes in feet and inches print like sizes in centimetres** - `4 ft 3 ×
  5 ft 2 in`, sharing the unit across the pair the way the metric ones always have.
- [faster] **Word, PowerPoint and the older `.doc` and `.xls` files find their
  preview sooner.**
- [faster] **Saving, autosaving and emptying the bin cost less on a big board.**
- [fix] **The sticker and sound windows stop leaking a little memory each time
  they open.**

## Face Up
version: 0.242 - 0.252
date: 17 August 2026

- **A release about cards that used to be blank.** A great many files that dropped
  in as a grey rectangle with a name now show their own picture, and the clips that
  would not preview at all finally do.

### Files that show their own picture
- [new] **Documents and design files show the thumbnail they were saved with.**
  Word, Excel, PowerPoint, Pages, Numbers, Keynote and OpenDocument files, the
  older `.doc`, `.xls` and `.ppt`, and Visio, Krita, Procreate, SolidWorks and 3ds
  Max files besides.
- [new] **Programs and app packages show their own icon.** A Windows `.exe` or
  `.dll`, an Android `.apk`, an iOS `.ipa`, a Windows `.appx`, an ebook, a comic or
  a 3D-print package shows its icon or its cover.
- [new] **Camera RAW and HEIC photos show a real image.** The app pulls out the
  preview the camera tucked inside, so a folder of `.cr2`, `.nef`, `.arw`, `.dng`
  or `.heic` files is a wall of pictures again.

### Video
- [new] **Clips a browser cannot play still get the right shape and facts.** AVI,
  WMV, FLV, MPEG and their kind now carry their true length and dimensions.
- [fix] **Video previews appear on Android phones and on Firefox.** A clip used to
  land as a blank card there, a phone's own camera footage being the exact case
  that failed.
- [fix] **Photo-heavy boards no longer run older iPhones and iPads out of memory.**
  The picture-shrinking that keeps a big board inside a tab's memory had stopped
  working on Safari before 16.4.
- [fix] **Emptying the bin actually frees the space.** A deleted file's data used
  to travel on inside the board and be written into every save afterwards.

## Fallow
version: 0.235 - 0.241
date: 16 August 2026

- **Nothing a reader would notice** - version bumps only.

## Every Corner
version: 0.206 - 0.234
date: 15 August 2026

- **The app was read end to end against its own stated intentions,** and the
  places where the two had come apart were repaired. One thing was added along the
  way.

### The one new thing
- [new] **A multi-select mode, for a finger.** While it is on, a tap on a card adds
  it to what is picked rather than replacing it, and nothing you do to the board
  underneath clears the selection. It ends from the row it was started from, from
  `Esc`, or from opening another board.

### Boards that would not behave
- [fix] **Deleting a saved board asks first,** and names it. It was one tap on a
  small glyph in the corner of a card whose whole face means Open, with no undo and
  no bin.
- [fix] **A board that has lost one file can still be left,** where the only way out
  had been `Clear everything`.
- [fix] **Reloading while a board is still opening no longer writes a blank one
  over it.**
- [fix] **Two boards stashed at once no longer lose one of them,** and the shelf is
  capped at twenty-four.
- [fix] **A board carrying its own colours keeps them** - the note washes, a card's
  shadow and how far a card leans.
- [fix] **A save that fails says so,** rather than leaving the button reading
  `Saving...` for the rest of the session.

### Pictures, PDFs and notes
- [fix] **PDFs draw on the live site.** The reader was fetched from another host,
  which the site's own security rules refuse, so every PDF and `.ai` card fell back
  to grey. It ships with mbrd now.
- [fix] **A note keeps its alignment and its markers through an export and a
  re-import.**
- [fix] **A handful of files that could stop the tab cannot any more** - a model
  asking for more memory than the machine has, a picture claiming thirty thousand
  pixels a side, a note with a long run of backticks.

## Every Step
version: 0.196 - 0.205
date: 14 August 2026

- **The Timeline arrived** - every change to the board as a step you can go back
  to - and a picture opened from the board learned to zoom.

### The Timeline
- [new] **The Timeline, under System, is every change to the board as a step you
  can go back to,** and it lives in the board file rather than in the tab, so it is
  still there tomorrow.
- [new] **A step can be given a name,** and a named step is a landmark you can find
  again months later.
- [new] **An align, a distribute or an arrange can be changed after the fact,** and
  everything you did after it happens again on top of the new answer.
- [new] **The Timeline offers to fold steps older than thirty days into the
  starting point,** leaving the board _unchanged_.
- [new] **Exporting asks whether to send the history with the board,** and the
  answer already under your thumb is to leave it out.

### The picture viewer, and what a board weighs
- [new] **A picture opened from the board zooms and pans.** The zoom goes to the
  point under the cursor rather than the middle of the window, so pointing at a face
  keeps the face.
- [new] **A line of a note can be drawn over with a marker,** in _four_ colours,
  the way a highlighter is.
- [new] **A crop reshapes the card it is in,** so a 16:9 slice of a square
  photograph stops being letterboxed. The area is held.
- [new] **`Flip` and `Flop` in the darkroom,** mirroring a picture left to right or
  top to bottom.
- [new] **`What is in this board` says where the weight went,** counting by kind and
  naming the ten heaviest files. Pressing a row travels the board to it.
- [new] **A style tile, carrying the palette, the faces and a few of the
  pictures.** It is a live card on the board: move the dial and every tile follows.
- [new] **A cut-out picture can drop its card,** landing on the board as the shape
  rather than in a box.
- [new] **The board file names its own parts,** so a `.mbrd` renamed to `.zip`
  opens with the pictures under the names of the cards they sit on.

### Repairs
- [fix] **Hovering a card animates again,** after several releases of it arriving
  instantly.
- [fix] **A note no longer sticks to the pointer after you change its face.**
- [new] **Something large is asked about before it comes in,** once for the whole
  drop, rather than two minutes into decoding it.

## On the Record
version: 0.177 - 0.195
date: 13 August 2026

- **The changelog became a page of the app,** printed the way your own board is
  printed.
- [new] **The changelog is a page of the app,** reached from System - so the look
  you set is the look you read it in.
- [new] **Nothing you touch on the changelog is kept.** The page never opens your
  session and never writes a preference.
- [fix] **The menu button has a hover you can see again.**
- [fix] **The slider thumb stops leaking its fill past its own border.**
- [fix] **Hovering works on a laptop that reports itself as a touchscreen.**
- **Maintenance:** the last of the app was typed, closing the migration to a
  language that checks itself.

## The Viewer
version: 0.131 - 0.176
date: 12 August 2026

- **Open one thing as big as the window will allow,** and the phone and the desk
  stopped pretending to be each other. Documents, PDFs and Markdown open properly.

### Open it big
- [new] **Open one thing as big as the window will allow,** with the board waiting
  behind it.
- [new] **Documents open properly:** Word, OpenDocument, slides, spreadsheets, CSV,
  SVG and comic archives.
- [new] **A PDF opens page by page,** so a long one starts reading before the whole
  file has been parsed.
- [new] **Markdown is set as prose,** on the card and in the viewer.
- [new] **A document shows the picture it already has of itself,** which most of
  these formats carry inside them.
- [new] **A dropped text file shows its opening words on the Feed** instead of its
  name, and the Feed has a right-click menu it had gone without.

### The phone and the desk
- [new] **Colour, Link and Stickers moved behind a More button on the phone,** so
  the toolbar holds what you reach for.
- [new] **The Board tab was rebuilt** around one primary section and one fold, with
  a View row at the top.
- [fix] **The note composer drew its sheet at life size, off to the left.** It sits
  under the card it belongs to now.
- [fix] **The sticker drawer shuts the moment a shape is dragged out of it.**
- [fix] **The Feed is printed on paper again,** after a spell on untextured stock,
  and shows the hint cards on a brand-new board.

### Under the bonnet
- [fix] **The app now tells you when something goes wrong,** on the board, in words.
- **Maintenance:** the app was moved to TypeScript and broken into smaller modules,
  and given a Content-Security-Policy. Nothing on a board changed.

## Threads and Shapes
version: 0.129 - 0.130
date: 11 August 2026

- **Draw a connection between two cards, drag a sticker onto the board, and leave a
  window open while you work.**
- [new] **Draw a connection between two cards,** and edit it from a small chip that
  follows the line while it is selected.
- [new] **Stickers,** a drawer of shapes you can drag onto the board and tint from
  the board's own palette.
- [new] **Windows you can move and leave open,** of which the sticker drawer is the
  first and the Playlist the second.
- [new] **Hover flyouts on the toolbar,** so a tool with options shows them where
  the tool is.

## Feed and Playlist
version: 0.126 - 0.128
date: 10 August 2026

- **The board can be read as one scrolling column, played as a playlist, and there
  can be more than one of it.**
- [new] **The Feed,** a board read as one scrolling column instead of a cramped
  canvas.
- [new] **The Playlist,** every piece of audio on a board, as a player.
- [new] **More than one board,** in a switcher that holds them all with a picture of
  each.
- [new] **Save a picture of the board, or a PDF of it.**
- [new] **Share, on a phone that has a share sheet,** with the board going into it
  as a file rather than as a download.
- [new] **A PDF dropped on the board shows its first page,** as does every other
  format carrying a preview picture inside it.

## Slow Morning
version: 0.124 - 0.125
date: 6 August 2026

- **Nothing a reader would notice** - version bumps only.

## Still Air
version: 0.123
date: 5 August 2026

- **Nothing a reader would notice** - a version bump only.

## Regions
version: 0.119 - 0.122
date: 4 August 2026

- **Fences draw a named region on the board, a colour picker chooses a pigment by
  eye, and mbrd is on the web at an address.**
- [new] **Fences,** a named region drawn on the board that the things inside it move
  with, readable at any zoom.
- [new] **A colour picker,** so a pigment can be chosen by eye rather than picked
  from a list.
- [new] **mbrd is on the web at an address,** with a 404 that is the app itself.
- [new] **At the softer end of the look, a region is drawn as a cork board,** with
  the stock to match.
- [new] **The whole app moved onto one set of drawn icons** rather than the
  characters it had been borrowing.
- [new] **The browser's copy of a board is tidied on every save,** so pictures
  belonging to something deleted a week ago stop taking up room.
- [fix] **Dropping a folder of more than five hundred files now says so.**

## Housekeeping
version: 0.113 - 0.118
date: 3 August 2026

- **A quiet day of repairs behind the scenes.**
- **Maintenance:** an import bug in a test put right, and the old CI workflow
  removed.

## Grain and Credit
version: 0.108 - 0.112
date: 2 August 2026

- **The paper got its tooth,** and the board grew a now-playing bar, a credits
  sheet and the toolbar it still has.
- [new] **The paper got its tooth,** a real 300gsm grain that travels with the board
  as you pan and zoom.
- [new] **A now-playing bar** for whatever the board is playing.
- [new] **The toolbar,** in the shape it still has.
- [new] **Threads route around the cards they pass** instead of running under them.
- [new] **A second typeface, Playfair,** which gives the softer end of the dial a
  face with some weight to it.
- [new] **A credits sheet** for the two people who made this.

## Held Breath
version: 0.106 - 0.107
date: 1 August 2026

- **Nothing a reader would notice** - version bumps only.

## Solid Ground
version: 0.91 - 0.105
date: 31 July 2026

- **A release about the board staying smooth while it moves, and about not losing
  anything.**
- [faster] **Saving and reopening a board full of photographs is much quicker,**
  without one round trip to storage per picture.
- [faster] **Exporting no longer holds the whole board in memory twice.**
- [faster] **Dragging a colour stops writing to disk sixty times a second.**
- [fix] **A board with an unresolved conflict refuses to save** rather than writing
  something half-merged over the good copy.
- [fix] **A picture from a board you had already closed can no longer reappear on
  the next one.**

## By the Beat
version: 0.76 - 0.90
date: 30 July 2026

- **Worked on against measurements rather than impressions,** taken against the
  display's own refresh.
- [faster] **Panning and zooming a large board** now costs what is on the screen
  rather than what is on the board.
- [new] **A redrawn app icon:** three cards on the grid.
- [new] **Cards animate out when they leave,** so something deleted reads as having
  gone rather than as having never been there.

## Light Load
version: 0.66 - 0.75
date: 29 July 2026

- **A lighter board on a phone: less decoded, less drawn, less loaded until you
  need it.**
- [faster] **Photographs are mounted at a sensible size** for how large they are
  actually drawn, and zoomed out the app sheds image decoding and card shadows
  entirely.
- [faster] **A video does not load until it is first played** on a touch device.
- [new] **The Mobile foot collapses into one flush row.**

## Low Tide
version: 0.61 - 0.65
date: 28 July 2026

- **Nothing a reader would notice** - version bumps only.

## Hardening
version: 0.52 - 0.60
date: 27 July 2026

- **The boundaries where a file comes in were tightened,** so a malformed or
  hostile file is refused rather than trusted.
- [new] **A ceiling on what one drop may bring in,** so a folder pointed at the
  board by accident is refused with a sentence.
- [new] **Sticky notes were rebuilt,** from how a note sizes itself to what happens
  to one too long for its own card.
- [fix] **Gestures snap to the board's real grid,** not to the lattice as it appears
  at the current zoom.
- **Maintenance:** every bundled typeface now carries its provenance and its
  licence, and a stray easter egg was removed.

## Pigment and Paper
version: 0.48 - 0.51
date: 26 July 2026

- **The palette is read off your own pictures,** and the app learned to trim a
  board, measure in real size and install properly.
- [new] **The palette is read off your own pictures,** taking the board's sheet, ink
  and accent from the photographs pinned to it.
- [new] **`Optimize`,** one menu item that trims a board down to what it actually
  needs.
- [new] **Real size,** so a paper outline dragged to scale tells you how big
  something is in millimetres or in inches.
- [new] **mbrd is installable properly,** with icons at both sizes and in the masked
  shape a phone crops to.
- [new] **A zoom pill and a scale bar** at the edge of the board.
- [new] **The furniture steps back when you leave the board alone,** and comes back
  the moment you touch anything.

## Taking Shape
version: 0.19 - 0.47
date: 25 July 2026

- **Pictures, 3D models and a board you can hold in one hand.**
- [new] **A picture on any card, and album art to fill a music card.**
- [new] **3D models on the board,** with no dependency to show for it.
- [new] **A YouTube link becomes a player,** if you ask it to.
- [new] **A live font switcher,** so each of the two type voices is chosen while you
  look at the result.
- [new] **Find on the board with `Ctrl+K`.**
- [new] **A board you can hold in one hand,** and the file format it saves to,
  specified and written down.

## First Light
version: 0.00 - 0.18
date: 24 July 2026

- **mbrd arrived** - an infinite freeform board in a browser tab with no account,
  no server and nothing uploaded.
- [new] **The whimsy axis,** one dial that takes the whole interface from scrapbook
  to spec sheet.
- [new] **Notes, links and audio cards,** with album art filling a music card and
  Markdown in a note.
- [new] **A web of threads between items,** drawn at whatever density the machine
  can afford.
- [new] **Save keeps the board in this browser, and Export writes a file you can put
  somewhere.**
- [new] **A bin that greys out when it is empty,** and renaming a card in place.
- [new] **Link cards,** which you can drag in from another tab.
