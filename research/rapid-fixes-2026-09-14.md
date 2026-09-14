# Rapid fixes, 2026-09-14

Items from the maintainer, in the order given. Each gets a checkbox, and the
box is ticked when its commit lands.

- [x] R1 The Timeline bar looks more like the history bar in Fusion 360
      (screenshot of 2026-09-14 17:28):
      - A slim custom scrollbar runs above the icons, across the track.
        The website's scrollbar is styled and fine. The desktop app on
        Windows draws the native Windows one, which looks bad. So the bar is
        drawn by the page, not by the browser, and looks the same everywhere.
      - The icons sit close together. A baseline with a small tick per step
        runs under the icons, not between them.
      - The playhead stands in the gap between two icons, not over an icon.
        The icon to its left is the last step shown.
      - **Done.** The track hides the system scrollbar, and `paintScroll()`
        draws a 4 px bar above the marks, with a draggable thumb, a press to
        jump, and the wheel turning the steps sideways. The playhead stands
        at the middle of the gap after the step shown, in Chromium and
        Firefox alike, and the view scrolls to keep it on screen.
- [x] R2 The Timeline bar keeps only Play and the gear. First, back, forward,
      last and the rename button go. The gear menu gets a "Hide timeline" row.
      - **Done.** "Name this point" moved into the gear menu. The arrow keys
        walk the steps from a focused mark, Home and End go to either end.
        The Timeline row in the View menu and the panel brings the bar back.
- [x] R3 Desktop: when a check finds a new version, the top right of the
      window says so, with an "Update" button. A press downloads the update,
      then installs it. Today the download starts on its own in the
      background, and the install runs when the app quits (`desktop/updates.ts`).
      - The maintainer dislikes the current update pop-up. The top-right
        control replaces the native dialogs, also for Help > Check for
        updates.
      - **Done.** A check no longer downloads. The title bar's Update
        button says each state: Update, Downloading 42%, Restarting, Retry
        update, and for Help > Check for updates, Checking, Up to date or
        No updates in a dev copy. A press on Update downloads, then installs
        and restarts. A copy that cannot replace itself opens the download
        page, with the how in the tooltip. `desktop/updates.ts` opens no
        dialog, and `tests/desktop-updates.test.js` holds that. Not tried
        in a packaged app: that needs a release newer than the copy.
- [ ] R4 Windows: the app icon still does not show on the desktop shortcut or
      in the taskbar. A fresh install of the new version did not fix it.
- [x] R5 The Timeline loses a board rename. Rename the board, step back to
      before the rename, step forward again: the old name comes back.
      - **A big problem, so it goes first.** Audit every change to the board
        that the Timeline and undo should keep: the title, board settings,
        backgrounds, fences, stickers, links, arrangement, per-card settings,
        the desktop and mobile layouts, and anything else that writes to the
        board. List each change that a step back and a step forward lose, fix
        them all, and add a test that fails for a change the history misses.
      - **Done.** One cause covered every case. A replay starts from `base`
        or a checkpoint, and those knew nothing of writes that were not
        steps: the title, settings, the look, fonts, the tour, the playlist
        order, the camera, and quiet card writes such as thumbnails.
        `timeline.ts` now writes that drift into every stored board before it
        records or replays, and `history.ts` keeps undo apart from drift.
        `tests/timeline-drift.test.js` walks every field in `REST_FIELDS`.
- [x] R6 The body font setting loses its "Same as display" option. A board or
      a preference that holds it today needs a sensible reading.
- [x] R7 Android: no update pop-up. The maintainer hates it. An update shows
      in the page instead (the sidebar's Update row, or a line like R3's),
      and "Check for updates" answers there too (`MbrdUpdate.java`,
      `MbrdShell`). Android's own install-confirm screen is the system's, and
      may stay where Android insists on it.
      - **Done.** Both AlertDialogs and the system toasts are gone. The
        sidebar's Update row says Update, Downloading 42% or Retry update,
        and the panel stays open so it can count. "Check for updates"
        answers in the page's own toast: up to date, updates off, no
        connection. A found version waits for the row's press, and the
        daily check still downloads quietly first.
- [x] R8 Feed cards get a simple drop shadow at the highest quality setting
      (`mobile.css`, the quality dial in `quality.css`).
      - **Done** at the Full stop. Harsh stays flat, as its canvas cards do.
- [x] R9 Feed: an image card set to Fit takes the aspect ratio of its photo.
      Today the card keeps some other ratio and letterboxes the photo.
      - Example (screenshot of 2026-09-14 17:50): a wide screenshot sits in
        a taller card, with a tinted band of card above and below it.
      - **Done.** The card's box on the board was the guess, and a resized
        card kept a shape that was not the photo's. `ui/feed.ts` now reads
        the shape off the picture as it loads, and lays the wall out again.
- [x] R10 The sidebar's close X (`#side-close`) is still not centred in its
      round hover plate, in Firefox (screenshots of 2026-09-14 17:54:52 and
      17:54:56). **The fifth report.** Earlier fixes did not hold, so rebuild
      the button from nothing: an SVG glyph centred by grid in a square box,
      with no text glyph, no line-height, no transform offset and no inherited
      padding. Measure the centre in both Firefox and Chromium (Playwright has
      Firefox) at every whimsy tier, and keep a test that fails when the glyph
      and the plate drift apart. The Harsh tier's no-spin rule stays.
      - **Done.** The cause: a 15 px glyph grid-centred in a 28 px button
        starts at 6.5 px, and each engine snapped it half a pixel off the CSS
        plate, on both axes. Measured from pixels before the fix: 0.5 px off
        at 100% in Firefox and Chromium on every tier, 0.8 px at 125%. Now the
        svg is the whole button and draws both the plate (a `rect` whose `rx`
        follows `--radius-pill`) and the 16 px cross about one centre. After:
        0 px at 100%, 125%, 150% and 400% in both engines on every tier, but
        for one ink row at Softish 100% that the probe's threshold cuts.
        `tests/close-plate.test.js` holds the numbers. `#header-close`
        shares the rules and got the same rebuild.
- [ ] R11 The top toolbar (`#toolbar`) responds to the window:
      - When the sidebar opens, the toolbar moves over and stays visible.
        Today it vanishes.
      - It adapts to the width: as the room shrinks, the buttons drop their
        text and keep their icons, and so on.
      - On a phone it still disappears, as it does now.
      - Mind the order rules in `index.html`: `#toolbar` sits after the
        sidebar and header panel, and the rules that move it are general
        sibling combinators.
- [x] R12 The small bugs from the research audit (`research/todo-2026-09-14.md`,
      "Should be done"):
      - HEVC poster frames are black on the website: `optimize/media-worker.js`
        calls `core.callMain`, which `@ffmpeg/core` 0.12.6 lacks. Use `exec`,
        and `reset()` between runs.
      - The drop overlay can stick (`import/drop.ts`): reset it on `dragend`
        and on a drop anywhere. Check first that it still sticks.
      - `storage/zip.ts` decodes every entry name as UTF-8. Decode CP437 when
        flag bit 11 is clear (Windows Explorer rezips).
      - `ui/viewer.ts` closes on `board:load`, as the sticker window does.
      - The three repository fixes: the `../` link in CONTRIBUTING, a pinned
        Linux FFmpeg URL in `fetch-ffmpeg.mjs`, and the repeated comment in
        `electron-builder.yml`.
      - The simplification leftovers: two `JSON.stringify` compares
        (`state.ts`, `timeline.ts`), and `pictureFrom()` inlined.
      - **Done.** The `state.ts` compare is now a field-by-field `sameRich()`.
        The compares in `timeline.ts` stay: they compare any JSON (a card, a
        setting, a stored board), and a field-by-field compare needs a shape
        to walk. The HEVC fix is not tried in a browser, because it needs the
        CDN core. The overlay also hides after 600 ms with no drag event, for
        a drag that leaves the window and ends outside it.
- [ ] R13 Share link and sync gaps (`research/docs/cloud.md`): first, keep the
      Drive session URI so a dropped upload resumes. Then a small viewing copy
      for recipients, a list of shared links that can be revoked, reopening a
      synced board without a fresh download, and cleanup of deleted assets.
- [ ] R14 Fences in the Feed follow the maintainer's rule: the cards of one
      fence always sit together, and fence groups interleave with loose cards
      by position (loose cards, a fence, more loose cards, another fence).
      Fencing happens only on the canvas, so a Feed drag never changes fence
      membership. Check the Feed against this, and fix any difference.
- [ ] R15 Tidy `research/`: bring `research/README.md` up to date (apps-tasks
      is built, list the new files), move finished documents to `old/`, and
      mark in each document the items the audit found done
      (`research/todo-2026-09-14.md`, "Already done").
- [x] R16 Feed: a press on the board title opens its edit menu at once, as
      the pen button does now.
- [x] R19 Feed: too much padding left and right. On a phone, the board sheet
      (the textured ground the cards sit on, `.feed-sheet`) runs the full
      screen width, and loses its rounded corners at the top and the bottom.
      - Phones only, below about 600 px. Wider screens keep the centred
        column (up to 940 px).
      - The gap between the outer cards and the screen edge equals the gap
        between cards (10 px).
      - The sheet still starts below the top buttons and ends above the
        bottom bar, as now. Only the sides and the corners change.
- [x] R20 Feed: the search button moves to the top right. When the pen button
      shows, the search button sits to the pen's left.
- [ ] R17 The spacing rhythm (design audit D4): the 13 different `gap`
      values across 20 stylesheets move to 2/4/6/8/12, one sheet at a time,
      with the app open to check each by eye.
- [ ] R18 A clutter pass at phone width, the way `research/ui-clutter-2026-08-15.md`
      audited the desktop. First the list of what to cut, for the maintainer
      to choose from, then the cuts.
