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
import { goHome } from '../page.ts';
import { board, setSetting, setBoardMode as selectBoardMode } from '../state.ts';
import { DEFAULT_SCALE } from '../measure.ts';
import { clearQualityOverrides } from '../quality.ts';
import { travelMs } from '../canvas/viewport.ts';
import type { Viewport } from '../canvas/viewport.ts';
import { togglePlayback } from '../canvas/audio.ts';
import { currentLens, setLens } from '../ui/board-view.ts';
import { togglePlayerWindow } from '../ui/playlist.ts';
import { openCredits } from '../ui/credits.ts';
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
}

export function viewCommands(vp: CommandViewport, { resetAppearance }: ViewDeps) {
  return {
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
    playlist: () => {
      if (goHome('playlist')) return;
      if (board.layoutMode === 'mobile') {
        if (currentLens() === 'playlist') { selectBoardMode('desktop'); toast('Back to the canvas'); }
        else setLens('playlist');
        return;
      }
      togglePlayerWindow();
    },
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
    // Dev: print what each swipe of a touchpad actually delivered - see the
    // wheel handler in canvas/input.js. The same shape as the grip overlay: an
    // attribute that module reads, a button that reflects it, and mbrd.debugWheel()
    // or the #wheel URL for the console.
    //
    // This one exists because the wheel handler is the only place in the app
    // that guesses at hardware, and the guess cannot be checked by reading it.
    // A two-finger scroll is railed by the platform before the page ever sees
    // it, and whether the sideways half arrives as nothing, as a trickle or in
    // hundred-pixel lumps decides which fix is the right one - a question only
    // the machine under the hand can answer.
    debugWheel: () => {
      const on = document.documentElement.toggleAttribute('data-debug-wheel');
      document.querySelector('[data-cmd="debug-wheel"]')?.setAttribute('aria-pressed', String(on));
      toast(on ? 'Swipe the board - each gesture prints to the console' : 'Wheel logging off');
      return on;
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
    // What changed, which is web/patch.html - the one page this site has that is
    // not the app. A command for the same reason the credit above is one, and it
    // sits beside it because the two are the same kind of thing: the only rows in
    // the panel that are about the app rather than about a board.
    //
    // A new tab, not this one. Everything you have is on the board behind this
    // panel, and leaving the page to read release notes would be asking somebody
    // to trust the autosave in order to find out what changed. `noopener` is not
    // ceremony either - without it the opened page gets a live handle on this
    // window through window.opener and can navigate it.
    patchNotes: () => { window.open('patch', '_blank', 'noopener'); },
  };
}
