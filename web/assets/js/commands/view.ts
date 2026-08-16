// The view half of the command surface: where the camera is, which board face
// is up, and the handful of chrome resets.
//
// Canvas / Feed / Playlist, play-pause, the scale, fit and recenter, the two
// debug overlays, the zoom lock, the appearance and quality resets, reload,
// restart, credits. One contiguous run of the object in commands.ts, lifted
// whole - see commands/file.ts for why the five runs became five files.
//
// ── The one factory that needs the Viewport ──
//
// createCommands() closes over the live Viewport because several commands are
// *journeys* rather than state changes, and every one of those is in this run:
// fit, recenter and the zoom lock are the whole of the app's relationship with
// the camera. So this factory takes `vp` and the other four take nothing, which
// is not an inconsistency - it is the split telling the truth about which
// quarter of the surface is about looking rather than about the board.
//
// `resetAppearance` is handed in rather than imported, and that is not this
// file's decision either: ui/appearance.ts touches a browser global at import
// time, so importing it anywhere but main.ts would cost a fourth exemption in
// tests/imports.test.js. main.ts already has one, so the function comes in from
// there and travels through createCommands to here.
//
// ── What must not move in here ──
//
// The Viewport itself. What a pan or a zoom *is* belongs to canvas/viewport.ts,
// and this file only ever asks it for one. A command that started doing the
// arithmetic would be the second place the camera lives.
//
// Nor the lens machinery. Which of Feed and Playlist is up is ui/board-view.ts;
// the three commands here are the buttons that ask for one, including the
// deliberate asymmetry that Canvas is idempotent and the other two are toggles.
//
// All three open with the same guard, which is the one thing about them that is
// not about lenses: on /patch there is no board to put a lens on, so goHome()
// navigates instead and the body below never runs. Before the guard, Feed put
// the empty board behind the changelog into the mobile layout and Playlist
// floated a player window over the prose. See page.ts.

import { toast } from '../notify.ts';
import { goHome, homePath } from '../page.ts';
import {
  board, isContent, isFiltered, select, setSetting, setTagFilter, tagFilter,
  setBoardMode as selectBoardMode,
} from '../state.ts';
import { DEFAULT_SCALE } from '../measure.ts';
import { clearQualityOverrides } from '../quality.ts';
import { cueLogOn, dumpCueLog, setCueLog } from '../cuelume/engine.ts';
import { onNarrowScreen, travelMs } from '../canvas/viewport.ts';
import type { Viewport } from '../canvas/viewport.ts';
import type { ViewPerf } from '../perf/view-perf.ts';
import { togglePlayback } from '../canvas/audio.ts';
import { currentLens, setLens } from '../ui/board-view.ts';
import { goToStop, startTour, stepTour, stopTour, tourActive, tourLength } from '../ui/tour.ts';
import { togglePlayerWindow } from '../ui/playlist.ts';
import { openCredits } from '../ui/credits.ts';
import { openInventory } from '../ui/inventory.ts';
import { toggleTimeline } from '../ui/timeline-view.ts';
import { paintZoom, zoomText } from '../ui/hud.ts';
import { reloadBoard, restartApp, scaleFromItem } from '../ui/board-actions.ts';

/**
 * The Viewport, under the name this run knows it by.
 *
 * This was a structural half of one - fit, recenter, isMobile, zoomLocked -
 * written because canvas/viewport.ts was still carried unchecked and there was
 * no Viewport type to import. The type landed, so the note that said "when the
 * real type lands this becomes an import" is now this line. The alias stays
 * because commands.ts extends it to say what *it* adds, and because a parameter
 * called a CommandViewport reads as the camera this run is given rather than the
 * class it happens to be.
 */
export type CommandViewport = Viewport;

/** What main.ts hands in through createCommands, of which this run wants one. */
export interface ViewDeps {
  resetAppearance: () => void;
  perf: ViewPerf;
}

export function viewCommands(vp: CommandViewport, { resetAppearance, perf }: ViewDeps) {
  return {
    /**
     * The tag filter: which tags the board is showing, and the two ways to
     * change it.
     *
     * In this run rather than with the tag *writes* in commands/item-meta.ts,
     * and the split is the one this file's header describes: those change the
     * board, and this changes what you are looking at. Nothing here is
     * undoable, nothing here is saved, and a filter left up when the board
     * closes is gone - see tagFilter in board-store.ts.
     *
     * `toggleTagFilter` builds the set up rather than replacing it, so ticking
     * three tags shows the union of three piles. The counting entry is what the
     * menu draws its "showing N of M" line from, and it exists because a filter
     * whose result is an empty board has to say so - otherwise a tag nobody
     * used any more just makes the board look wiped.
     */
    tagFilter: () => [...tagFilter],
    hasTagFilter: () => tagFilter.size > 0,
    isTagFiltered: (tag: string) => tagFilter.has(tag),
    toggleTagFilter: (tag: string) => {
      const next = new Set(tagFilter);
      if (!next.delete(tag)) next.add(tag);
      setTagFilter(next);
    },
    clearTagFilter: () => setTagFilter([]),
    filterCounts: () => {
      const shown = board.items.filter(i => isContent(i) && !isFiltered(i)).length;
      const all = board.items.filter(isContent).length;
      return { shown, all };
    },
    /**
     * Select everything the filter is showing.
     *
     * The bridge between a filter and everything else the app can do to a
     * selection: line them up, fence them, tag them again, rearrange just
     * those. Without it a filter would be a way of *looking* only, and the
     * commonest thing anybody wants after narrowing a board down is to act on
     * what is left.
     */
    selectFiltered: () => {
      if (!tagFilter.size) return;
      const ids = board.items.filter(i => isContent(i) && !isFiltered(i)).map(i => i.id);
      if (!ids.length) { toast('Nothing on the board carries those tags'); return; }
      select(ids);
    },
    /**
     * The two mobile boards, each its own sidebar button.
     *
     * Feed is the masonry wall of everything; Playlist is the audio player. On the
     * canvas, Feed takes the whole board into its mobile view and Playlist opens
     * the floating window over the canvas instead - a player, not a takeover. Once
     * in the mobile view the pair are a switch between the two lenses, and pressing
     * the one already up steps back out to the canvas, which is the only way back
     * now that the old single toggle is gone. setLens before the mode switch so
     * entering the mobile view lands on the lens that was asked for.
     */
    /**
     * The third segment of the View row: back to the freeform board.
     *
     * Idempotent, unlike the two below it, and that is the whole of the
     * difference. Feed and Playlist are toggles - pressing the lens you are
     * already on steps back out to the canvas, which is the only way back now
     * that the old single toggle is gone - so neither can be the button that
     * *names* the canvas. This one can: pressed from the canvas it does nothing,
     * pressed from either lens it comes back. selectBoardMode() already returns
     * false for a mode that is live, so the toast is only for a real crossing.
     */
    canvas: () => {
      if (goHome('canvas')) return;
      if (selectBoardMode('desktop')) toast('Back to the canvas');
    },
    feed: () => {
      if (goHome('feed')) return;
      if (board.layoutMode === 'mobile') {
        if (currentLens() === 'feed') { selectBoardMode('desktop'); toast('Back to the canvas'); }
        else setLens('feed');
        return;
      }
      setLens('feed');
      selectBoardMode('mobile');
    },
    /**
     * Playlist, which is two different surfaces and one button.
     *
     * On a phone-width window it is always the lens: the album view, full
     * screen, which is the size it was drawn for. Always, in both senses - the
     * floating window is never opened there, and pressing it while the lens is
     * already up does *nothing* rather than stepping back to the canvas.
     *
     * The toggle-out is what Feed keeps and this gives up, and they are not the
     * same button. Feed is the board; stepping out of the board to the canvas is
     * a real move between two views of the same thing. The playlist is a player,
     * and a player closing itself because you reached for it twice is a player
     * that has hidden the track you were about to choose. Canvas is one press
     * away and names itself, which is the way back from either.
     *
     * With room on screen it is the floating window over the canvas - a player,
     * not a takeover - unless the board is already in the mobile view, where a
     * window would float over a surface that has the list on it. onNarrowScreen()
     * rather than onTouch(): what decides this is whether there is room for a
     * window, and a touchscreen laptop has as much of it as any other laptop.
     */
    playlist: () => {
      if (goHome('playlist')) return;
      if (onNarrowScreen()) {
        setLens('playlist');
        if (board.layoutMode !== 'mobile') selectBoardMode('mobile');
        return;
      }
      if (board.layoutMode === 'mobile') {
        if (currentLens() === 'playlist') { selectBoardMode('desktop'); toast('Back to the canvas'); }
        else setLens('playlist');
        return;
      }
      togglePlayerWindow();
    },
    /**
     * The tour: the board read as a sequence of stops.
     *
     * In this run rather than beside the tag writes in commands/item-meta.ts,
     * and it is the same split that file's header describes: putting a card
     * *on* the tour changes the board, and these four only change where the
     * camera is pointing. The runner itself is ui/tour.ts - see the head of
     * that module for why it is in ui/ and why the index it walks is not a
     * field on the board.
     *
     * `tourStep` and `tourStop` answer whether they took the press, which is
     * what makes them usable as the first try in canvas/input.ts's arrow and
     * Escape cases: the same shape as playPause() below and
     * deleteActiveConnection(). While the bar is up the arrows belong to the
     * tour even at its last stop, so tourStep answers true there rather than
     * dropping the press through to nudging the selection a pixel.
     */
    tourStart: () => startTour(),
    tourStop: () => stopTour(),
    tourStep: (delta: number) => stepTour(delta),
    tourGo: (i: number) => goToStop(i),
    inTour: () => tourActive(),
    tourLength: () => tourLength(),
    // Space, from the canvas key handler: play or pause the current track. Returns
    // whether it did - false when nothing is loaded, so Space falls back to pan.
    playPause: () => togglePlayback(),
    scaleFromItem,
    // Resetting the sheet's size and resetting the board's scale are the same
    // act: the sheet is drawn at whatever A4 works out to under the current
    // scale, so there is nothing else its size could be stored in. Named for the
    // scale rather than for the paper because it also puts the readout, the
    // scale bar and every item's measurement back.
    resetScale: () => {
      if (board.settings.scale === DEFAULT_SCALE) return;
      setSetting('scale', DEFAULT_SCALE);
      toast('Back to the default size');
    },
    // The title card is left out on Mobile for the same reason canvas/items.js
    // does not mount it there: it is not on that board. Fitting the view to a card
    // nobody can see - parked above the column by completeLayout() - would zoom
    // out to make room for nothing.
    fit: () => vp.fit(
      board.items.filter((i: { type: string }) =>
        board.layoutMode !== 'mobile' || i.type !== 'title'),
      80, travelMs()),
    recenter: () => vp.recenter(travelMs()),
    // Dev: paint the resize corner grab zones, which have no ink of their own, so
    // their reach can be checked by eye (see [data-debug-grips] in canvas.css). A
    // toggle that reflects on its own sidebar button; also on mbrd.debugGrips()
    // and the #grips URL. Grips only show on a selected card, so select one first.
    debugGrips: () => {
      const on = document.documentElement.toggleAttribute('data-debug-grips');
      document.querySelector('[data-cmd="debug-grips"]')?.setAttribute('aria-pressed', String(on));
      return on;
    },
    /**
     * Arm the frame profiler, and print what it saw.
     *
     * The profiler has existed for a long time with no way into it from the
     * interface at all: `mbrd.perf.on()` from a console, or the `#perf`
     * fragment, which is the only one of the two a phone has - and a phone is
     * the device whose frames are worth timing. These two rows are that door.
     *
     * The same arrangement as the grip overlay above: this writes its own
     * aria-pressed, because the fragment and the console drive the one toggle
     * and a value painted by the panel would go stale behind either.
     */
    debugPerf: () => {
      const on = !perf.active;
      if (on) perf.on(); else perf.off();
      document.querySelector('[data-cmd="debug-perf"]')?.setAttribute('aria-pressed', String(on));
      toast(on ? 'Profiling - pan and zoom for a while, then Print the report' : 'Profiling off');
      return on;
    },
    /**
     * The report, to the console.
     *
     * Its own row rather than something the toggle prints on the way off,
     * because the useful sequence is arm, drive the board about, read, drive
     * some more - and turning the profiler off to see the numbers would reset
     * the counters that produced them.
     */
    debugPerfReport: () => {
      if (!perf.active) { toast('Turn profiling on first, then pan and zoom'); return; }
      const r = perf.report();
      toast(r ? 'Report printed to the console' : 'Nothing sampled yet - pan or zoom first');
    },
    /**
     * The transcript of every interface cue, and what became of it.
     *
     * The same two-row shape as the profiler above - arm, use the app, print -
     * and it is here for the same reason that pair is: the question it answers
     * is asked while somebody is *using* a board, and until now the only way in
     * was a console, on a tool whose sounds are most worth checking on a phone.
     *
     * **What it is for is the lines that are not there.** Three separate reports
     * of the sounds skipping turned out to be a call site missing from a branch
     * - a resize grip, a widget press, a multi-card drop - rather than anything
     * in the engine, and each was found by reasoning about pressIntent() one
     * branch at a time. Pressing a thing and seeing whether the log says
     * anything at all settles it in one go, which is why the log records
     * refusals as loudly as it records sounds: a muted cue and a cue nobody made
     * must not look the same.
     *
     * Unlike the two toggles above it, this one is *remembered* - the useful
     * session is turn it on, reload, reproduce - so the button reads its state
     * back through cueLogOn() as well as being written here. That is the
     * opposite of the note over the grips row, and for the opposite reason:
     * there the truth is a DOM attribute nothing else can be asked for, here it
     * is a function.
     */
    debugSound: () => {
      const on = setCueLog(!cueLogOn());
      document.querySelector('[data-cmd="debug-sound"]')?.setAttribute('aria-pressed', String(on));
      toast(on
        ? 'Logging cues - use the board, then Print the cue log'
        : 'Cue logging off');
      return on;
    },
    /** The transcript as a table. Its own row, for the reason the report is. */
    debugSoundReport: () => {
      if (!cueLogOn()) { toast('Turn cue logging on first, then use the board'); return; }
      const rows = dumpCueLog();
      toast(rows.length
        ? `${rows.length} cue${rows.length === 1 ? '' : 's'} printed to the console`
        : 'Nothing logged yet - press something first');
    },
    // Hold the magnification where it is. A command rather than two lines in the
    // click handler, because that is what a user-facing action is here - the one
    // surface a key binding or a menu row would bind to if either ever wants it.
    lockZoom: () => {
      if (vp.isMobile) {
        toast(`Mobile zoom follows the ${board.settings.mobileColumns}-column width`);
        return;
      }
      vp.zoomLocked = !vp.zoomLocked;
      paintZoom(true);
      toast(vp.zoomLocked ? `Zoom locked at ${zoomText()}` : 'Zoom unlocked');
    },
    resetAppearance,
    // Hands every quality flag back to the dial. The same way back Appearance's
    // fold keeps, for the same reason: a panel of overrides with no way home is a
    // panel you stop touching.
    resetQuality: () => {
      clearQualityOverrides();
      toast('Quality back to the dial');
    },
    reload: reloadBoard,
    restart: () => restartApp(),
    // Who made this. A command rather than a listener on the footer button, for
    // the reason every other action here is one: the sidebar knows about data-cmd
    // and about nothing else, so this is the only wiring the panel needs.
    credits: () => openCredits(),
    // A report, so it is a sheet rather than a panel section - see the head of
    // ui/inventory.ts. It sits beside credits here because both are "open the
    // one screen that says something", which is the whole of what they share.
    inventory: () => openInventory(),
    // The Timeline. A toggle rather than an open, because it is a surface you
    // consult and dismiss rather than a screen you go to - and because it is
    // the one piece of chrome in the app you might want on the whole time you
    // are working, which makes closing it something the same control should do.
    //
    // One command for both faces: which one this window gets - the strip along
    // the foot, or the sheet a narrow window can actually read - is decided
    // inside ui/timeline-view.ts, because it is a fact about the width and not
    // about the action.
    timeline: () => toggleTimeline(),
    // What changed, which is web/patch.html - the one page this site has that is
    // not the app. A command for the same reason the credit above is one, and it
    // sits beside it because the two are the same kind of thing: the only rows in
    // the panel that are about the app rather than about a board.
    //
    // This tab, not a new one, and that is a reversal. It was a window.open for
    // a good reason - everything you have is on the board behind this panel, and
    // leaving the page to read release notes reads as being asked to trust the
    // autosave in order to find out what changed. What settled it is that the
    // trip is not a leap of faith and the new tab was not free:
    //
    //   The board is already written down on the way out. main.ts flushes on
    //   pagehide *and* on visibilitychange - the open note closed, the snapshot
    //   taken - so the state this navigation leaves behind is the same state a
    //   refresh leaves behind, which the app has always survived. Back, or the
    //   changelog's own View row (goHome in page.ts, the far end of this trip),
    //   restores it.
    //
    //   A new tab flashed. A browser paints a tab it has just opened in its own
    //   theme, before the document it is going to fetch has committed anything -
    //   so on a dark-themed browser every visit to the changelog opened on a
    //   black rectangle and then a cream page, and nothing this app can put in
    //   patch.html paints that frame. Its <meta name="color-scheme"> is read
    //   after it. Navigating in place has no such frame at all: the engine holds
    //   the board on screen until the changelog has painted, which is the same
    //   reason a refresh of this app does not flash either.
    //
    // Through homePath() rather than the bare 'patch' window.open took, for the
    // reason goHome() does it: the address is relative to wherever the app is
    // hosted, not to the page it is being asked from.
    patchNotes: () => { location.href = homePath() + 'patch'; },
  };
}
