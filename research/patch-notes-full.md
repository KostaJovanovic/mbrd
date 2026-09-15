# mbrd patch notes - the full record

THE LONG VERSION, AND AN ARCHIVE. Every release written out at the length it was
first written at: the features, the repairs, the performance work, and the runs
of internal work that never reached a screen - the module splits, the type
migration, the test counts, the layering rules.

**Nothing generates a page from this file and nothing reads it.** It is here to
be read by somebody who wants the whole story of a release rather than the part
of it that changed what the app does. `patch-notes.md` at the repository root is
the live source: it carries the same releases, the same codenames, the same
version spans and the same dates, cut down to what a person using the app would
recognise, and `node tools/gen-patch-page.mjs` builds `/patch` from it.

Why the two are separate, since a changelog that says everything is not obviously
worse than one that says less: a reader of `/patch` opened it to find out what is
different for them. Forty bullets about the shape of the code, mixed in among six
about the app, do not add to that - they bury it. So the technical record keeps
its full length here, where the audience for it is somebody with the repository
open, and the page keeps only the entries that mean something without it.

**It is not maintained.** It was true on the day it was split off and it is a
record of what was written, not a second source to keep in step. A release added
after that split is written in `patch-notes.md`; if the long version of it is
worth keeping, it goes here as well, by hand, and the writing rules are the ones
stated at the top of that file.

## Releases

## Unpacked
version: 0.318 - 0.402
date: 14 September 2026

- **Two lists worked through in one day.** The afternoon cleared the fix list
  written after the apps shipped, batches A to H, and the evening an audit of
  every item the research documents still left open, R1 to R38. An archive became
  a card you can open, the Timeline moved to the foot of the window, and the tour,
  the fences and both apps' updates were rebuilt along the way.

### Archives and folders

- [new] **A dropped ZIP, TAR, `.tar.gz`, `.gz`, 7z or RAR arrives as one archive
  card:** its name and an `Unzip` button. `Unzip` replaces the card with what was
  inside, in a spiral round where it sat, in the archive's own order, as one undo
  step. A folder inside lands as a folder card with an `Open` button, which does
  the same one level down, and an archive inside lands as another archive card.
  On the Feed both put the files in the card's place in the column.
- [new] **A folder dragged in from Explorer or Finder** still spreads its own
  files over the board, but each folder inside it now lands as one folder card,
  its files kept with it rather than scattered.
- The reader is the app's own for ZIP and TAR, every size and checksum measured
  against the end of the file, and gzip goes through the browser's inflate under
  the same ceilings as every other import. 7z, RAR and ZIP64 go through
  libarchive.js, vendored and loaded on the first archive that needs it rather
  than in the bundle. Its flat list of entries is read and its tree is not, since
  the tree writes path segments as object keys. Paths are cleaned: no `..`, no
  `__MACOSX`, no `.DS_Store`.

### The Timeline

- [new] **The Timeline docks along the foot of the window at every width,** as a
  history bar does in a CAD program. It gives its height to the layout, so the
  board ends above it rather than under it. On by default, off by default on a
  phone, and the last choice is kept per device. The narrow-window sheet it used
  to open in is gone, and it no longer closes on `Esc`, since a docked bar is not
  a layer.
- [new] **The bar was then cut down after Fusion's history bar.** The marks sit
  close on a baseline with a tick per step, the playhead stands in the gap after
  the step shown, and the view scrolls to keep it in sight, with a thin scrollbar
  of the page's own above the marks. `Play` and the gear are the only buttons:
  first, back, forward, last and the name button went, with their icons. The gear
  holds `Name this point`, the size, the trim and `Hide timeline`. The arrow keys
  walk the steps from a focused mark, and `Home` and `End` go to either end.
- [new] **The current step is a grey mark with an ink tick,** so the playhead is
  the only accent on the bar. The `5 of 8` count went, `Play` has an edge and a
  ground of its own and steps three and a half times a second, and the playhead
  shows a grab cursor. A hovered step no longer grows and loses its top edge to
  the track.
- [new] **`Show timeline` is a box at the top of the Board tab's `Other`
  section,** since it is on or off, and `Hide timeline` in the gear says in a
  toast where to find it again.
- [fix] **A trip through the Timeline keeps every change that was not a step.** A
  replay started from the stored base or a checkpoint, which knew nothing of
  writes that were not steps - the title, the settings, the tour, the connections
  - so going back and forth could quietly put them back. The Timeline now
  compares the board with the one its record describes before it records or
  replays, and a test holds every board field to a round trip.
- [fix] **A step through the Timeline redraws the cards it changes.** A replay
  announced the whole board, which only placed the cards again, so a card kept
  the look it had: a note stayed faded after its fade was stepped back, and lost
  its shadow. The canvas now compares each card with the item it was drawn from
  and redraws the ones whose name, file or settings differ.
- [fix] **`Play` and the gear line up with the panels, and the gear is a
  button.** The bar's side padding went from 10px to 14px, the panels' inset, so
  `Play` stands under the sidebar's edge and the gear under the header panel's.
  The play triangle moved one unit left, to the middle of its button. The gear
  now has the edge, ground and lift that `Play` has, where it was a bare icon.
- [new] **While `Play` runs the board is read-only.** `commit()` refuses every
  edit and puts back a caller that had already changed the board, every press on
  the canvas pans, a card's own controls and a double-click included, and only
  the keys that move the view, `Esc` and `Ctrl+S` still work. A drop shows no
  overlay and a paste lands nowhere. The toolbar's editing tools, undo and redo,
  the drawer and the masthead pen go inert and dim to 40%, `Find` stays, and the
  gear is disabled. A refused edit says `The board cannot change while the
  timeline plays. Press Pause first.`, at most once in two and a half seconds.
  Only `Pause` stops a replay, besides its own last step and another board
  loading: a press anywhere used to pause it, as did any edit. `Hide timeline`
  while it plays says to pause first, since the bar holds `Pause`.
- [new] **`Delete timeline` in the gear.** It asks first, then drops every step,
  their names and the undo stack, and the board as it stands becomes the start.
  The board does not change and the next save writes it without the old history.
  The gear now lists what it does first - name, fold, delete, hide - and the size
  of the history as a line under them, and the fold row is absent rather than
  greyed when nothing is old enough to fold.
- [fix] **A reload opens at the newest step.** The file keeps the playhead where
  it stood, so a board left after a few undos came back that many steps back,
  with the newest steps ahead of it. Not on a stale history, and not on opening a
  file.
- [fix] **The steps move by whole steps.** The track is sized to as many whole
  steps as the bar has room for, so no mark is ever drawn cut at either end, and
  the wheel, the scrollbar and a finger's swipe all land on a step. Every scroll
  the page makes itself keeps the current step in view. The reader's own do not,
  so the scrollbar and the wheel reach the oldest steps, and the next change of
  step brings the view back.
- [fix] **Play and Pause sit in the middle of their button.** The glyphs are 16
  pixels on an even 38-pixel rail, so neither starts on a half pixel, which
  Firefox rounded and set the two bars of Pause a pixel off. The triangle stands
  one pixel right, where its weight reads as centred.
- [fix] **The sidebar's shadow stops at the Timeline.** Both panels end above the
  bar and their shadow falls downward, so it darkened the strip; it is clipped at
  the bar's top edge now.
- **The history moved out of `board.json`.** A `.mbrd` now carries it as
  `timeline/base.json` and `timeline/steps.jsonl`, one step to a line, and a torn
  line marks the history stale rather than losing the board. Every older `.mbrd`
  still opens with its history. A copy of mbrd from v0.316 or older opens a new
  file without one.

### The tour

- [new] **A board with no tour shows one `Create tour` row.** `Take the tour` and
  `Edit the tour` appear once a tour exists.
- [new] **On tour and in the editor no card lifts, moves or resizes.** The editor
  holds every card as anchored - a press picks, a drag pans - and has no card
  menus, no viewer, no note editing and no renaming.
- [new] **The `+` or number on a card in a multi-selection acts for the whole
  selection,** and pressing it no longer collapses the selection to that card.
- [new] **On tour only the stop on show takes a press, and only to play.** One
  clip or song in a stop plays by itself after two seconds, starting the tour
  pauses the board's music, and leaving a stop pauses its clips.
- [new] **The tour bar has two rows:** the name and caption over back, the count,
  forward, the stop's actions and close. After an action the tour stays where it
  is.
- [new] **A stop chip or a card's number under the pointer lights that stop and
  fades the rest,** its connections included.
- [new] **`Delete` in the editor takes the picked stop off the tour** as one undo
  step, and the toast that says so carries `Undo` - the first toast in the app
  that can.

### Fences and badges

- [new] **Fences, the second version.** A fence's menu gains `Colour` - none, or
  one of the four note sheets under the names the Note flyout uses - and
  `Roll up`. Rolled up, a fence draws only its name bar, as a tab in its colour,
  and every card inside it, nested fences too, is hidden and out of reach: the
  marquee, `Ctrl+A` and the connection lines pass it by. `Find` rolls down every
  fence hiding the card it picks. The cards keep their places, so a moved fence
  still carries them. Both are one undo step and survive a save.
- [new] **A new fence starts free and anchors itself ten seconds after its last
  move,** once and quietly, with no undo step of its own. The preview box over a
  would-be fence is gone, and a fence's menu says `Remove fence`.
- [new] **The anchor and pin badges are buttons,** shown on hover and on select.
  A press on the anchor unanchors the card, a press on the pin lets the note come
  away, and the tour mark moves to the left of a badge.
- [new] **The Feed shows fences.** It used to hide them and scatter their cards
  through the wall. A fence's name now heads its cards, and each run starts below
  the whole of the one before. The Mobile layout's runs were wrong the same way,
  every loose card after the last fence, and now a run of loose cards forms
  between two fences in the arrangement's order, so a repacked Mobile board
  changes to match.

### Pictures, documents and the style tile

- [new] **`Demosaic` develops a camera RAW from its sensor.** A RAW card draws the
  JPEG its camera tucked inside the file, which is sometimes a postage stamp. The
  new row runs LibRaw over the sensor data in a worker, puts the result where the
  preview was and cuts the thumbnail and the display copy from it, as one undo
  step. The RAW stays the card's file. A sensor big enough to cost more than a
  gigabyte while it works asks first, like every other ceiling in the app.
- [new] **`Optimize` develops a RAW before it shrinks it,** using the picture
  `Demosaic` already made where there is one, and one RAW at a time, so a phone's
  tab survives it. The result replaces the RAW as an ordinary photograph.
- [new] **A Word file with no baked thumbnail shows page one,** set on a page of
  the file's own size and margins: the text in the built-in styles, inline
  pictures shrunk to the text width, tables as rows of text. It stops at the foot
  of the first page.
- [new] **The style tile shows eight named swatches** - paper, card, ink, ink-3,
  rule, accent, warm and leafy - in two rows of four under the pictures, with the
  two faces at the foot. Hovering one shows its hex as the palette has it now, a
  click copies it with `Copied #hex`, and a press on a swatch never drags the
  card. The caption plate stays hidden on a style tile, as on a photograph, so it
  no longer covers the body face's name.
- [fix] **`Picture sharpness` decides again.** Since the display copies arrived,
  every photograph drew at the 1024-pixel copy whatever the dial said. That copy
  now serves only at `Soft`. Above it a plain photograph gets a copy at the dial's
  edge, and the original takes over past that.
- [fix] **An HEVC clip's poster frame is no longer black.** The media worker
  drove the newer ffmpeg.wasm through a call that version does not have.

### Cards on the board

- [new] **A card set to `Fit` takes its picture's shape.** From its menu or from
  the board's Fill switch, a photo or video card keeps its shorter side and the
  longer one follows the picture's proportion, in the same undo step as the fit.
  `Fit` pressed again on a card already set to it brings it back to shape, and a
  corner drag holds the shape until Shift frees it. The app reads the proportion
  off the display copy, the poster frame or the file, applies the crop and the
  quarter turn, and caches it by hash. Desktop layout only: the Feed already draws
  Fit tiles at their shape, and on the packed Mobile grid a grown card would land
  on its neighbours. Anchored cards keep their size, as under `Reset size`.
- [new] **A sticky offers `Low opacity` where it offered `No card`.** The paper
  goes to 60% and the words stay solid, and the pointer or an edit brings the
  paper back to full. Only the card's background colour changes, so the adhesive
  band stays and the change fades. Its shadow twin goes, since it showed through
  the sheet as a grey block, and the export paints the same note. A note that
  already has no paper still shows `No card`, ticked, so the paper can come back.
  Pictures and models keep `No card`.
- [fix] **A faded sticky is see-through at Harsh, and whole again far out.** The
  Harsh rule for a sticky's paper outranked the fade and painted it solid. Both
  now read one `--note-sheet` colour, which the fade sets. Below the far-zoom
  rung the note's body is down and the item is the whole note, and a faded one
  had no colour there, so it was a name floating on the board. It takes the pad
  colour back at that zoom.
- [fix] **A note's name drops the `#` of its heading.** A note is named for its
  first line, and `meta.text` marks a heading line with `# `, so Find, the
  Timeline, the far-zoom head, the tour list and the screen reader all said
  "# Note A". A new or edited note is named without it (`noteNameOf()`), and a
  name stored with it shows without it (`shownName()`) until the note's next
  edit. The file keeps whatever name it has.
- [new] **Ctrl and the wheel move the board up and down,** as Shift and the wheel
  move it across. A touchpad pinch also arrives as a wheel event with Ctrl set,
  so the canvas watches the Control key itself: a Ctrl that is really held pans,
  and a pinch, which presses no key, still zooms.
- [fix] **Below 40% zoom a card's buttons go.** The anchor and pin badges and the
  title card's pen and `T` stayed until 10%. They now go with the labels at the
  far-zoom rung, and the title card's raise and hover bridge follow it.
- [fix] **An audio card at far zoom keeps its play button inside it.** The button
  is sized to the room under the name, where it hung off the card's foot, and the
  kind and its rule left the head. A card with a sleeve wore its kind and name
  over the art, because the rule that hides the head lost on specificity to the
  rule that shows it. Now it shows the art with the button centred on it.
- [new] **`Tilt cards` on the Look tab,** a box above `Show grid`, on by default.
  Off stands every card square on Softish and Middle, and a drag still tilts the
  card in the hand. Harsh stands cards square anyway, so there the box has no
  say. The shadow twins, the connection routes and the export read the same
  setting. Desktop only, like `Show grid`, and not an undo step.
- [new] **A card wider than eight grid spaces or taller than six rests
  straight,** where only a card wider than ten did. A resize across that line
  straightens the card on the frame it crosses and gives it back its own angle,
  not a new one, when it comes back inside; a card built too large is dealt a
  lean the first time it fits. Fences and stickers are left alone.
- [fix] **The hover lift is in board units,** as the grow is, so the pop looks the
  same at every zoom. In screen pixels it was a fixed jump that threw a card at
  far zoom by most of its own height. The drag lift stays in screen pixels, since
  that card sits under the pointer.
- [fix] **`Fit`, recentring and the zoom buttons centre in the room an open
  sidebar leaves.** The view asks how far the panel reaches in, the same reach
  the sidebar pans by, and frames in what is left. Not on a Mobile board, and not
  where the panel covers the screen.
- [fix] **Connection lines hold still under a carried card.** While a card is in
  the hand nothing reroutes: every other line keeps the route it had, the held
  card's own lines run dead straight to the cards they join, and one pass routes
  the lot on the drop. Routing on a pause rerouted the whole board under a hand
  that was only resting.
- [fix] **The close, plus and zoom-in crosses draw each stroke as its own path.**
  As two subpaths of one path the strokes can cancel where they cross, and
  Firefox left a hole in the middle of the close cross at Harsh.

### The sidebar, the menus and the toolbar

- [new] **Every sidebar dropdown is a picker,** like Palette: Layout, Units, Paper
  outline, Picture sharpness and Cards built per frame. The native select is gone
  from the panel. The Display and Body font pickers set each row in its own face,
  `Default` on top and then A to Z with the board's own faces sorted in, and
  typing jumps to a match.
- [new] **A menu opened under a press follows that pointer.** A move lights the
  row under it, and a release on a row after a move or a hold picks it. A plain
  click still leaves the menu up.
- [new] **The Board tab was sorted.** `Save` stands alone in the open, with
  `Save As` and `Export` under a fold labelled `More`. The Tour section became
  `Other`, and holds the tour buttons, the Timeline and `Board contents`, which
  moved from System because they are about the board and not the browser.
- [new] **`Board contents` peeks a clip.** A video row showed nothing on hover for
  any clip the browser can play, since it looked only for a cover or a poster.
  Now the clip plays in the peek, muted and looped, over the still its card uses,
  and lets go of its source when the pointer leaves.
- [new] **The top toolbar moves with a panel and fits the room.** It centres
  between its side margins, and an open sidebar or masthead panel widens its
  margin, so the bar slides over rather than vanishing. It measures what fits:
  every tool with its word, then icons only, then Colour, Link and Stickers behind
  `More`. At phone width it still hides with the panel.
- [new] **Opening and closing the sidebar pans the board by half its reach.** The
  Feed layout's Playlist lens slides right with it and centres in the room the
  panel leaves, above 600 pixels, since narrower the panel covers the screen.
- [new] **The sidebar and the header panel fill the screen at 600 pixels or
  less,** where they did from 700 with the rest of the phone layout. From 601 to
  700 the phone layout holds, and the panel is the 322-pixel sheet at the side.
  The zoom controls and the masthead pen stay up beside it, a tap on a row no
  longer closes it, and on a Desktop board it pans the view as it does on a
  wide screen. The move is
  one block in `mobile.css` and `panelFillsScreen()` in `ui/sidebar.ts`, which
  ask the same width, and a test holds the two together. The slider focus, which
  dissolves the panel while one of its ranges is dragged, moved with it: at the
  side the board is already in view, and the dissolve only hid the panel.
- [new] **The Playlist button shows once music has been on the board,** and the
  first song imported on the canvas opens the player once. An older board with
  music gets it on load, quietly. No Playlist button on the bar while a video
  plays.
- [new] **The Header panel's `Font` is the sidebar's face picker,** `Default` on
  top and every face A to Z with the dropped faces sorted in, each row in its own
  face. `Font size` reads in pixels on the Mobile board, and every
  step changes the name: the size was written rounded to 1% of the board's width
  while a step is about 0.2%, so four steps in five did nothing, and the slider
  now ends at the 18.75% cap the stylesheets set. `Line height` sits under
  `Wrap long names`, 12 pixels clear of it, and shows only while wrapping is on.
  `Wrap long names` is off on a new board. `Start over` is `Reset`, and the hint
  about variable controls went.
- [fix] **The foot row sits level with the sidebar.** The now-playing bar, the
  zoom and drawer buttons, the tour bar and its editor, the drawer window, the
  sticker pad and the Desktop Playlist window moved from 16 to 14 pixels off the
  bottom.
- [fix] **The quality section's `Start over` reads `Reset`,** as Appearance's
  does.
- [fix] **The interface sounds start switched off.** They are experimental, the
  panel says so under the dial whenever it is on, and every copy was set back to
  off once, after which a dial moved sticks. The quality dial's one-line hints
  went, and `Moving GIFs` reads `Animated GIFs`.
- [fix] **The body font list lost `Same as display`,** and a look that still
  carries it reads as the default body face.
- [fix] **The sidebar's close cross sits in the middle of its plate** in both
  engines at every zoom and on every tier, where it had been half a pixel off,
  and it rides the top of the panel's head, as far from the top as from the side.
  Sans labels stay upright at the middle and harsh tiers, and the palette picker
  and the pigment swatch are the size of the rest.
- [new] **The Keys list draws each key as a cap:** 30 pixels high, a one-letter
  key square and a longer one growing sideways, with a row's keys kept together
  at its left and the `+` between them.
- [fix] **The toolbar follows a window being resized exactly.** Its slide is for a
  panel coming in at its side, and every move of a dragged window restarted it
  from wherever the last had got to, so the bar trailed the window and stepped
  after it. The slide comes back once the window has been still for a moment.
- [fix] **The credits' round faces have a round focus ring,** standing off the
  picture, where a baseline gap under the image made it an oval.

### The look

- [new] **The corners travel between whimsy tiers.** Moving the dial hangs a class
  on the page for as long as the colours fade, and for that time every element's
  own transitions give way to one on its corners, so the type, the shadows and
  the grid still change at once. Board cards and Feed tiles ease only while on
  screen and at 40% or closer; further out a card is a speck. Into Harsh the
  corners go in 40% of the fade, where they took Harsh's own tenth of a second,
  which read as no animation, and the run restarts on the first two frames, since
  the tier change can hold the page longer than the run lasted. The inner rule of
  a card at Harsh and of a ghost card at Softish is made unseen rather than
  removed, so it eases with the card instead of appearing at its end radius, and
  the whimsy dial's ghost is a pill at Softish.
- [fix] **A card's lift, lean and grow travel through the fade.** The fade zeroed
  every transition so nothing chased the sheet's colours, and a card popped up
  with no travel after every load and every tier change. The movement reads no
  colour and is exempt now; the hover ring still is not.
- [new] **One panel corner.** The sidebar, the dialogs, `Find`, the player and the
  drawer wore a corner a hair over the one the menus, the library and the Feed's
  sheet wore, two panel corners on one screen a couple of pixels apart. The
  larger one went. The sidebar and the header panel then took the toolbar's
  corner, since they stand level with it and the zoom pill along the top, and the
  menus, the sticker pad and the Feed's floating sheet followed them. Buttons in
  the corner of a bar run parallel to it.
- [new] **The glass buttons are square,** 42 pixels with a mouse and 45 on
  touch, where they were 42 by 40 and 46. The zoom pill's three parts, the
  history pair and the icon-only toolbar are each a row of those squares, their
  ring drawn inside rather than as a border that took height off every one. The
  toolbar, the menu button and an open panel's top stand on one inset, 12 pixels
  at phone width, and the foot row's heights are the button's own. The toolbar's
  words sit a pixel higher, where a centred row read as low.
- [new] **A pill is a real length now,** 26 pixels rather than 999, since 999
  cannot travel between tiers: it spends the whole way above every box's
  half-height and snaps in the last frames. At Harsh it is zero, so the card
  badges, the viewer's close over a photograph, the Feed's pick circles and the
  Timeline's marks are square there. At Softish the glass controls the corner
  scale left a pixel or two short of round are rounded the rest of the way.


- [new] **Feed tiles are their canvas cards.** Style tiles, fonts, models,
  generic cards and gone cards draw the board's own renderer at the item's shape,
  scaled to the tile. A video tile has no native controls: a tap plays in the
  tile, a second tap pauses, and the now-playing bar drives it.
- [new] **A press on the Feed's title opens the masthead editor,** as the pen
  does.
- [new] **`Find` on the Feed scrolls to the hit and rings it** for a second and a
  half. It used to select the hit and fly the hidden canvas, so the wall stayed
  put and nothing was marked.
- [new] **Feed tiles can be selected.** Ctrl, Shift or Cmd with a click adds a
  tile to the board's selection or takes it out, and the tile does not open. A
  long press offers `Select multiple`, after which each tap picks a tile and `Esc`
  ends the mode. A selected tile wears a ring in the selection colour, and in the
  mode every tile shows an empty circle, a picked one a filled circle with a tick.
  A click between the tiles clears the selection, and the tile menu, `Delete` and
  `Tags` act on the whole group.
- [new] **An audio tile's play button sits in the middle of the tile,** 44 pixels
  across, as a video tile's does, where it was a small badge in the corner.
- [new] **A stuck note rides its host's tile.** On the wall it had a tile of its
  own, somewhere else in the order, cut off from the card it is about. Now it
  takes no slot: a small sticky in the tile's top-right corner, in the top note's
  colour, counts the notes, and a press lays them open over the tile on a scrim,
  top note first, scrolling inside the tile when there are many. A press on a
  note opens it, a press between them folds them away, and the tile remembers
  being open when it scrolls out and back. A note on a note rides the first host
  with a tile. `Find` on a stuck note shows its host with the notes open. While
  the Timeline plays the tile menus do not open.
- [fix] **The Feed on a phone.** At full quality a tile stands on a soft drop
  shadow, a picture set to `Fit` takes its own shape as it loads rather than the
  shape of its card's box on the board, below 600 pixels the Feed sheet runs the
  full width with square corners, and `Find` moved to the top right.
- [fix] **What did nothing on a phone went.** A Feed tile's menu prints no key
  hints and has no `Reload board` and no `Anchor`. The sidebar drops
  `Rearrange everything`, `Spacing`, `Snap to grid`, `Show grid`, `Show axes` and
  `Show readout`, none of which changed the Feed. The font hint tells a phone to
  add a face from Add, then Files. The empty Playlist lens has a button back to
  the board.

### Sharing through Drive

- [fix] **A dropped upload goes on from the last byte that landed.** A chunk with
  no answer, or a busy or failing server, used to end a Drive upload. It now
  waits, doubling the wait, up to five times, asks the session how much it holds
  and sends on from there, and the stopped-upload dialog gains `Try again`, which
  resumes the same pack. The old same-size check on a sync could have spliced two
  different boards together, and it went.
- [fix] **A push clears the files its board stopped naming.** After the board
  lands, every file in its Drive folder that the board no longer uses goes to the
  Drive bin, if it is more than a day old, so another machine's push in progress
  is never swept. A file that will not go waits for the next push.
- [new] **`Shared links` lists every board this account has shared,** newest
  first and from any machine, each row with `Copy link` and `Stop sharing`.
  Stopping asks first and moves the file to the Drive bin.
- [new] **A heavy board can be shared as a viewing copy.** A board over 20 MB is
  packed twice, and when the second pack is at most 60% of the first the sender
  chooses. The viewing copy shows every photograph as its display copy and every
  clip as a picture of its poster, and leaves out the bin and the history.
- [new] **The apps sign in to Google Drive outside the page.** The web sign-in
  window fails in both apps, so the desktop runs the sign-in in the system browser
  and Android asks Google's own account screen, each handing the page a token for
  the one permission the app uses. The clients are not registered yet, so both
  apps show no Drive rows rather than broken ones, and still open a shared link.
  A share link made in an app names the website rather than the app's own address.

### The desktop and Android apps

- [new] **The desktop's Update button.** The check runs once a day and no longer
  downloads on its own. When it finds a newer version a green `Update` shows at
  the right of the title bar, and a press downloads it with the button counting,
  `Downloading 42%`, then installs and restarts, writing the board to its file
  first. A failed download says `Retry update`. A copy that cannot replace itself,
  on macOS or portable, opens the download page. `Check for updates` answers on the
  same button, `Checking for updates` and then `Up to date`, and no native dialog
  is left.
- [new] **Android's updates say everything on the page.** A daily check downloads
  in the background, or waits when Data Saver restricts it. An `Update` row at the
  top of the sidebar offers it, counts while it downloads and says `Retry update`
  when it fails, and a passing answer comes as a toast. Both dialogs and the
  system toasts went. The install-confirm screen is Android's own and stays.
- [new] **An unsaved board is marked with `*`** on the title bar and in the window
  title.
- [new] **A Linux `.deb` beside the `.AppImage`.** It installs a file type for
  `.mbrd`, so a board opens on a double-click, and a `.deb` copy announces an
  update rather than installing it, since root owns its folder. The download page
  names it. The next release run is its first build.
- [faster] **A desktop save appends only what changed.** New and changed entries
  and a fresh directory go on the end of the board's file, and a picture the file
  already holds is pointed at rather than written again. `Save As`, `Export`,
  `Optimize` and a file more than half waste make the next save a whole write,
  which compacts it. A tail cut short by a crash is walked past to the last good
  save. The web and Android keep the whole write.
- [fix] **An update no longer crashes the app it just installed.** The installer
  starts the new copy before it exits, so its own file was still locked when the
  new copy tried to clear it away, and that failure ended the start.
- [fix] **The Windows shortcuts have their icon back.** The installer writes the
  package's description into every shortcut, and that description was two
  thousand characters of notes with quotes in them, which broke the shortcut's
  line: the Desktop and Start menu shortcuts carried a slice of prose as their
  icon path, and the taskbar button went blank with them. The description is now
  `mbrd`. The `.ico` frames below 256 pixels are plain bitmaps, as Windows wants.
- [fix] **Android's bars are black in dark mode and white in light mode,** where
  they followed the page's colour through a flood of calls that made them
  flicker.
- [fix] **The apps' Debug readouts stop talking about a browser,** and Storage
  names the boards folder.

### Board files

- [fix] **A board keeps what a newer mbrd wrote into it.** Every top-level key
  this build does not know rides through a save untouched, so a newer build's
  field survives an older build's save. A ZIP whose leading mimetype names another
  format is refused with `This is not an mbrd board`, and a board with no mimetype
  still opens.
- [fix] **A ZIP from Windows Explorer shows its names as written.** A name without
  the UTF-8 flag that is not valid UTF-8 reads as the old DOS code page, the way
  Explorer writes it.
- **The board format grew:** `hadMusic` at the top level, the `archive` and
  `folder` card types, a fence's `tint` and `rolled`, `demosaiced` on a developed
  RAW card, `faded` on a note at low opacity, the board setting `tilt`, and the
  history's own two files. An
  older build shows the new cards as plain named cards and writes them back
  untouched. A board with no Mobile header at all now opens with `Wrap long names`
  off, and a header written before that setting existed still reads as wrapped.

### Repairs

- [fix] **`New` while a note had focus threw,** and the rest of the old board's
  cards were never cleared. The note gives up focus first now. Found while
  failing to reproduce a report that the website's board list kept only the
  current board: it held every board in every scenario tried.
- [fix] **The drop overlay hides when a drag ends,** and after 600 milliseconds
  with no drag event, rather than standing over the board.
- [fix] **The viewer closes when another board loads.**
- [faster] **A dragged note asks only the cards near it** whether it should stick,
  where it scanned the whole board on every pointer move. A sticker dropped from
  its window does the same.

### Maintenance

- **The research was audited.** Every open item in the research documents was
  checked against the code and listed, and the rapid-fix list drawn from it became
  R1 to R38. The documents that are done went down to `research/old/`, the
  `future/` tier was deleted, and the README lists only what is open.
- **Every pixel gap in the stylesheets is on one rhythm** - 2, 4, 6, 8 or 12 -
  fifty gaps in eighteen sheets, checked by eye before and after, with a test to
  hold it.
- **Seventeen surfaces were sampled frame by frame** through a palette change and
  two whimsy changes, and every one fades as one. Nothing needed changing.
- **The picture-led palette moved into a module of its own,** loadable in a test
  with no browser.
- **The releases no longer carry a source zip,** and `save.bat` builds the
  portable copy only when asked, as option 6, rather than spending ninety seconds
  on it every save. A README for the public release repository was drafted.
- **The v0.381 release run failed on two legs, and both now pass.**
  electron-builder refuses a `.deb` without a homepage and builds one only on
  Linux, so the first release with the `.deb` was the first to find out, and the
  desktop package now names the site. On macOS the smoke test read the board
  before the stored one was back and saw the blank default, so it now waits for a
  card on the board.
- **The patch notes gained 13 and 14 September.** A check against the 9am day
  break moved the start of Pocket Size to 0.304, and this archive gained the days
  from 0.235 to 0.303, which only the page carried. The last comments that named the fix list point at its record in
  `research/old/`. A second pass took Unpacked to 0.402, the last save before
  09:00 on 15 September.
- **A dev server on a link-local address is a dev server.** The app and the
  service worker treat 169.254 hosts as local, as they did the private ranges,
  so a server reached over a direct cable stops being cached at the last version.
- **Credit where it is due:** the credits name ONNX Runtime, u2netp, Geist Mono,
  the evermeet.cx and John Van Sickle FFmpeg builds, Electron, sharp and
  Capacitor, and libarchive.js, which opens 7z and RAR. LibRaw arrived with
  `Demosaic`.

## Pocket Size
version: 0.304 - 0.317
date: 13 September 2026

- **mbrd is an Android app,** built in an evening as a third package around the
  same `web/` tree the website serves, with no fork of the app code. The
  desktop's boards became files you can see. Everything here builds and its tests
  pass. The checks that need a phone in a hand were still to be run.

### Android

- [new] **An `.apk` for Android 7 and later,** built on GitHub beside the desktop
  builds and published in the same release. Capacitor wraps the page, and a
  bridge gives the phone the desktop's own shape, so the app runs through the
  branch the desktop already has.
- [new] **The boards live in `Documents/mbrd`** and the store in a hidden folder
  beside them, so both survive an uninstall and the boards show in Files. The
  grant is asked for once, on a screen that says why. `Not now` keeps everything
  in the app's private folder for that run, a note on the board says where, and
  the next start asks again. The first run with the grant moves the private store
  across.
- [new] **Save, Open and Import.** Save asks for a name, and asks again before it
  replaces a file. Open copies a board from anywhere into the board folder, as
  `name (2).mbrd` on a clash, except a board already there, which opens in place.
  Import copies nothing: each file's bytes go into the store.
- [new] **Open with and Share, for boards, pictures, clips, sound, PDF and
  text.** A board opens, every other file lands as a card at the centre of the
  view, and a shared link becomes a link card. A file that arrives before the page
  is ready waits for it.
- [new] **What a WebView lacks, added.** A download link hands its bytes to the
  Save dialog a board uses, `navigator.share` goes to the system share sheet, and
  Back closes the top layer - an open menu, then a dialog, then whatever answers
  `Esc` - and with nothing left open sends the app to the background with the
  board kept.
- [new] **A pause is a close.** A phone does not close an app, it pauses it and
  may end it after, so the write the desktop runs before a close runs on the
  pause.
- [new] **Updates, from the public release repository.** At start, at most once
  every six hours, the app reads the latest release. A newer version asks first,
  downloads with a progress bar, is checked against the digest GitHub publishes
  for it, and installs, on Android 12 and later with no confirm screen.
- Bytes never cross Capacitor's JSON bridge. They go page to native through a
  byte channel of their own, in chunks with one in flight at a time, and native to
  page as a plain request, so a board is never turned into base64 on the way.
  `/_capacitor_file_/` and `/_capacitor_content_/` answer 404, because they would
  give any page script a reader for every file the app can reach, and every check
  lives in the Java plugins rather than in the bridge.

### The desktop

- [new] **Every desktop board is a file in `Documents/mbrd`.** `New` makes the
  file at once, and the page writes the board on screen to it on a timer, with
  the store as the crash copy. A portable copy, and a run given its own data
  folder, keep the boards in `boards/` in the data folder instead, so neither
  writes outside its own folder.
- [new] **The board list shows the folder.** It lists the shelf and every board
  in the folder, an `Open folder` button leads to the files, and the Open and
  Save dialogs start there. The cross on a board in the folder moves the file to
  the bin, where it can be restored. A board kept elsewhere only leaves the list,
  and its file stays where it is.
- [fix] **`Cmd+Q` quits the macOS app.** The quit waited for the board to be
  written and then stopped short. It quits again after the write.
- [fix] **The macOS build is universal.** The release job installs sharp's Intel
  half beside the runner's own, and the native files that are not themselves
  universal are named so the merge keeps them, so an Intel Mac gets the native
  picture decoder too.

### Maintenance

- **The release job builds all four apps at once** - Windows, macOS, Linux and
  Android. Each smoke test is capped at a minute, logs the quit path and prints
  the app's logs when it fails, and the changelog test counts visible windows,
  since the hidden menu panel can arrive between two counts.
- **The Android release is signed with a key kept offline,** and its
  `versionCode` is the commit count, which only grows, as an update needs.
- **The apps have their documentation:** `mobile/README.md`, the mobile section
  and the release in the project notes, and the launchers in the contributing
  guide.
- The scratch folders from the connection-line work were deleted.

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
  beside the program. A browser may clear its own storage to make room. A folder
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
- [fix] **Sizes in feet and inches print like sizes in centimetres.** They read
  `4 ft 3 × 5 ft 2 in`, with one unit for the pair, as the metric ones always did.
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
