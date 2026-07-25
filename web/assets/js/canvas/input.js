// Pointer + keyboard gestures for the canvas.
//
// One Pointer Events pipeline handles mouse, pen and touch. Exactly one gesture
// is active at a time (`g`), and a second finger always wins - it cancels an
// in-progress drag and takes over as a pinch, which is what makes two-finger
// pan/zoom feel right on a phone.
//
// Gesture map:
//   left-drag empty space ....... pan            (an infinite board pans more than it marquees)
//   shift / ctrl + drag empty ... marquee select
//   middle-drag or space+drag ... pan, from anywhere
//   drag an item ................ move the whole selection, plus anything stuck to it
//   drag a corner grip .......... resize (aspect-locked for media, shift to free it)
//   wheel ....................... zoom to cursor;  shift+wheel pans horizontally
//   two fingers ................. pan + pinch zoom

import { clamp } from '../util.js';
import {
  board, byId, selection, select, clearSelection, topZ, stackOrder,
  snapshotGeom, applyGeom, commitGeom, bus, stuckFollowers,
  copyItems, cutItems, pasteItems, clipboardSize, clipboardBounds, clipboardHasOurs,
} from '../state.js';
import { zoomMs, travelMs } from './viewport.js';
import { itemInRect, MIN_SIZE, MAX_SIZE } from '../geometry.js';
import { itemIdFromEvent, ensureMounted, sync as syncItems, editItemName } from './items.js';
import { gridStep } from './grid.js';
import { noteFloor } from './notes.js';

const DRAG_SLOP = 3;      // screen px before a press becomes a drag
// How long a finger has to rest before the press means "show me the menu".
// Long enough not to fire on a slow tap, short enough to feel deliberate;
// it is the interval both mobile platforms use for the same gesture.
const LONG_PRESS_MS = 480;

// MIN_SIZE and MAX_SIZE are the resize limits, in world units, and they live in
// geometry.js - a resize handle stopped being the only thing that sets a size
// when snapping learned to lay the whole board onto the lattice. The reasoning
// behind both numbers is written there. The floor's job here is the one it has
// always had: the eight grips are sized in screen pixels, so as an item shrinks
// they crowd it rather than shrinking with it. The ceiling's is the drag that
// leaves the window at high zoom - without a stop, one flick could carry an
// item to a size that makes Fit frame the board at nothing.

export function initInput(vp, cmds) {
  const el = vp.el;
  const marquee = document.getElementById('marquee');

  /** pointerId -> latest client position, for multi-touch bookkeeping. */
  const pointers = new Map();
  let g = null;            // the active gesture
  let spaceDown = false;
  // Where the cursor is, and where it was when the last copy was taken - the
  // two halves of "has the pointer moved since?", which is what decides where
  // a paste lands. Both null on a touch device, and a null falls back to the
  // old behaviour rather than guessing.
  let hover = null;
  let copiedFrom = null;
  // A long press is the touch equivalent of a right-click, and without it the
  // context menu is unreachable with a finger - which is where duplicate,
  // delete, send to back and rename live. Held here rather than inside the
  // gesture, because it has to survive the gesture being replaced (a second
  // finger arriving) and be cancelled by it.
  let pressTimer = 0;
  let pressAt = null;
  const cancelPress = () => { clearTimeout(pressTimer); pressTimer = 0; pressAt = null; };

  // ---- helpers ----------------------------------------------------------

  const snapVal = v => {
    if (!board.settings.snap) return v;
    const step = gridStep(board.settings.gridStep, vp.zoom);
    return Math.round(v / step) * step;
  };

  /**
   * One axis of a resize: the extent it should end up with, given the box the
   * gesture started from and how far the pointer has travelled along that axis.
   *
   * `sign` is +1 when the handle drags the high edge (east, or north - world y
   * points up), -1 for the low one, and 0 for an axis the handle does not
   * touch, whose extent comes back untouched.
   *
   * Snapping quantises the *moving edge's world position*, not the extent.
   * Rounding a width to the step would leave both edges off the lattice, since
   * the pinned edge was never on it to begin with; it is the edge the pointer
   * is actually holding that has to land on a grid line for the result to sit
   * flush against the dots on screen. The extent then falls out of the distance
   * back to the edge that stayed put, which is why the anchor is derived here
   * rather than the size being adjusted afterwards.
   *
   * The limits are applied before the snap so the rounding is handed an edge
   * that is already legal, and repaired after it by stepping one grid line the
   * other way: rounding can only move the edge by half a step, so one line
   * always brings it back inside, and the answer is still on the lattice rather
   * than parked at a bare limit that no grid line passes through. The closing
   * clamp is what actually guarantees the range - it has to hold even where the
   * step is coarser than the whole band between floor and ceiling, and a floor
   * that only usually holds is the same collapsed item it exists to prevent.
   */
  function resizeAxis(sign, centre, extent, travel) {
    if (!sign) return extent;
    let size = clamp(extent + sign * travel, MIN_SIZE, MAX_SIZE);
    if (board.settings.snap) {
      const anchor = centre - sign * extent / 2;
      const step = gridStep(board.settings.gridStep, vp.zoom);
      const k = Math.round((anchor + sign * size) / step);
      size = sign * (k * step - anchor);
      if (size < MIN_SIZE) size = sign * ((k + sign) * step - anchor);
      else if (size > MAX_SIZE) size = sign * ((k - sign) * step - anchor);
    }
    return clamp(size, MIN_SIZE, MAX_SIZE);
  }

  function setPanCursor() {
    el.classList.toggle('can-pan', spaceDown && !g);
  }

  function startPan(e) {
    g = { kind: 'pan', lastX: e.clientX, lastY: e.clientY };
    el.classList.add('is-panning');
  }

  function startMarquee(e) {
    const p = vp.toWorld(e.clientX, e.clientY);
    g = { kind: 'marquee', x0: p.x, y0: p.y, x1: p.x, y1: p.y, additive: e.shiftKey };
    marquee.hidden = false;
    drawMarquee();
  }

  function drawMarquee() {
    // The screen's top-left corner is the world's (min x, *max* y) - world y
    // points up.
    const a = vp.toScreen(Math.min(g.x0, g.x1), Math.max(g.y0, g.y1));
    const b = vp.toScreen(Math.max(g.x0, g.x1), Math.min(g.y0, g.y1));
    marquee.style.left = a.x + 'px';
    marquee.style.top = a.y + 'px';
    marquee.style.width = (b.x - a.x) + 'px';
    marquee.style.height = (b.y - a.y) + 'px';
  }

  function applyMarquee() {
    const x0 = Math.min(g.x0, g.x1), x1 = Math.max(g.x0, g.x1);
    const y0 = Math.min(g.y0, g.y1), y1 = Math.max(g.y0, g.y1);
    const hit = board.items
      .filter(i => itemInRect(i, x0, y0, x1, y1))
      .map(i => i.id);
    select(hit, g.additive);
  }

  function startMove(e, id) {
    // Whatever is stuck to the selection comes with it. Worked out once, here,
    // and then held for the length of the gesture: recomputing it per frame
    // would let notes latch on and fall off as the drag swept the selection
    // across other items, so the group you picked up would not be the group you
    // put down. What is stuck when you take hold is what travels.
    const moving = [...selection, ...stuckFollowers(selection)];
    // Snapshotted here, before anything is touched, so the raise below rides
    // along in the same undo entry as the move it belongs to.
    const before = snapshotGeom(moving);
    const start = vp.toWorld(e.clientX, e.clientY);
    g = {
      kind: 'move', id, moving, before, start,
      origin: before.map(b => ({ id: b.id, x: b.x, y: b.y })),
      moved: false,
    };
    for (const sid of moving) ensureMounted(sid);
  }

  /**
   * Bring the gesture's items to the front. Called on the first movement past
   * the slop, not on the press that started it.
   *
   * It used to happen in startMove(), which meant a plain click reordered the
   * board. Nothing committed it, because only a gesture that actually moved
   * gets a history entry - so clicking an item changed its z with no undo entry
   * to reverse it and no markDirty() to say the board had changed. The change
   * was real and the record of it was not: a later unrelated save would write it
   * out, and closing the tab straight after would lose it, and either way the
   * user had done nothing but click.
   *
   * Deferring it costs nothing visible. The slop is three pixels, so anything
   * that is a drag raises before it has visibly moved, and anything that is a
   * click leaves the stack exactly as it found it.
   */
  function raiseToFront(ids) {
    // Bottom-to-top rather than in selection order, so the group keeps its
    // internal stacking. That is what leaves a stuck note still above the thing
    // it is stuck to when the pair lands, and so still stuck.
    let z = topZ();
    for (const sid of stackOrder(ids)) byId(sid).z = ++z;
    bus.emit('geom', ids);
  }

  function startResize(e, id, corner) {
    const it = byId(id);
    if (!it) return;
    const before = snapshotGeom([id]);
    g = {
      kind: 'resize', id, corner, before,
      start: vp.toWorld(e.clientX, e.clientY),
      box: { x: it.x, y: it.y, w: it.w, h: it.h },
      // Media keeps its aspect unless shift says otherwise; cards resize freely.
      lockAspect: it.type === 'image' || it.type === 'video',
    };
  }

  // ---- pointer pipeline -------------------------------------------------

  el.addEventListener('pointerdown', e => {
    if (e.button > 1 && e.pointerType === 'mouse') return;   // right/aux: leave alone
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // A second finger always converts the gesture into a pinch.
    if (pointers.size === 2) {
      cancelPress();
      abortGesture();
      const [a, b] = [...pointers.values()];
      g = {
        kind: 'pinch',
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
      return;
    }
    if (pointers.size > 2) return;

    const target = e.target instanceof Element ? e.target : null;
    const grip = target?.closest('.grip') || null;
    const id = itemIdFromEvent(e.target);
    // A real control inside a card (the audio scrubber, a note being edited)
    // owns the whole gesture: no capture, no drag. Capturing here would redirect
    // every following pointermove to #viewport and leave the scrubber dead.
    // .vtrack is the video scrubber; a video's own <video> is deliberately not
    // in this list, because the picture is the card and dragging it has to drag
    // the card. Only the transport laid over it claims the gesture.
    const widget = target?.closest('audio, video[controls], input, button, a, .wave, .vtrack, [contenteditable="true"], [contenteditable="plaintext-only"]');

    if (widget && !spaceDown && e.button !== 1) {
      if (id) select([id]);
      pointers.delete(e.pointerId);
      return;
    }

    el.setPointerCapture(e.pointerId);

    if (spaceDown || e.button === 1) {
      e.preventDefault();
      startPan(e);
    } else if (grip && id) {
      startResize(e, id, grip.dataset.g);
    } else if (id) {
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      if (additive) select([id], true);
      else if (!selection.has(id)) select([id]);
      startMove(e, id);
    } else if (e.shiftKey || e.ctrlKey || e.metaKey) {
      startMarquee(e);
    } else {
      if (selection.size) clearSelection();
      startPan(e);
    }

    // Armed after the gesture, so the early returns above - a widget claiming
    // the press, a second finger - never reach it. It waits out the whole
    // duration and then checks that the press is still a press: a drag cancels
    // it from pointermove, and lifting cancels it from endPointer.
    if (e.pointerType === 'touch' && pointers.size === 1) {
      pressAt = { x: e.clientX, y: e.clientY, id };
      pressTimer = setTimeout(() => {
        const p = pressAt;
        cancelPress();
        if (!p) return;
        // Whatever the finger had started - a move, a pan, a marquee - it was
        // not that. Dropped rather than committed, since nothing moved.
        abortGesture();
        openMenuAt(p.x, p.y, p.id);
      }, LONG_PRESS_MS);
    }
    setPanCursor();
  });

  el.addEventListener('pointermove', e => {
    // Before the gesture guard below, which drops every pointer that is not
    // pressed - and a hovering mouse is exactly that. Touch is excluded
    // because a finger that is not down is not anywhere.
    if (e.pointerType !== 'touch') hover = { x: e.clientX, y: e.clientY };
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // A finger that has travelled is dragging, not pressing. The same slop the
    // move gesture uses, so the two agree about when a press has become a drag.
    if (pressAt && Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) > DRAG_SLOP) cancelPress();
    if (!g) return;

    if (g.kind === 'pinch') {
      const [a, b] = [...pointers.values()];
      if (!a || !b) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      vp.panByScreen(mid.x - g.mid.x, mid.y - g.mid.y);
      vp.zoomAt(mid.x, mid.y, dist / g.dist);
      g.dist = dist;
      g.mid = mid;
      return;
    }

    if (g.kind === 'pan') {
      vp.panByScreen(e.clientX - g.lastX, e.clientY - g.lastY);
      g.lastX = e.clientX;
      g.lastY = e.clientY;
      return;
    }

    if (g.kind === 'marquee') {
      const p = vp.toWorld(e.clientX, e.clientY);
      g.x1 = p.x; g.y1 = p.y;
      drawMarquee();
      applyMarquee();
      return;
    }

    if (g.kind === 'move') {
      const p = vp.toWorld(e.clientX, e.clientY);
      const dx = p.x - g.start.x, dy = p.y - g.start.y;
      if (!g.moved && Math.hypot(dx * vp.zoom, dy * vp.zoom) < DRAG_SLOP) return;
      // The press has become a drag. Raise now, so the stack change belongs to
      // the move that is about to be committed - see raiseToFront.
      if (!g.moved) raiseToFront(g.moving);
      g.moved = true;
      // Snap the dragged item; everything else keeps its offset from it, so a
      // multi-selection moves rigidly instead of collapsing onto the grid.
      const lead = g.origin.find(o => o.id === g.id) || g.origin[0];
      const sx = snapVal(lead.x + dx) - (lead.x + dx);
      const sy = snapVal(lead.y + dy) - (lead.y + dy);
      applyGeom(g.origin.map(o => {
        const it = byId(o.id);
        return { id: o.id, x: o.x + dx + sx, y: o.y + dy + sy, w: it.w, h: it.h, rot: it.rot, z: it.z };
      }));
      return;
    }

    if (g.kind === 'resize') {
      const p = vp.toWorld(e.clientX, e.clientY);
      const dx = p.x - g.start.x, dy = p.y - g.start.y;
      // Zero on an axis the handle does not touch: dragging the east edge must
      // leave the height alone, where a corner moves both.
      const c = g.corner;
      const signX = c.includes('e') ? 1 : c.includes('w') ? -1 : 0;
      // 'n' is the +y side of the item, because world y points up.
      const signY = c.includes('n') ? 1 : c.includes('s') ? -1 : 0;
      let w = resizeAxis(signX, g.box.x, g.box.w, dx);
      let h = resizeAxis(signY, g.box.y, g.box.h, dy);
      if (g.lockAspect !== e.shiftKey) {          // XOR: shift inverts the default
        // A fixed ratio and both edges on the lattice are not both achievable,
        // so with snap on the dominant side is the one that lands on the grid
        // and the follower goes wherever the ratio puts it. That is the right
        // way round: the side you are watching move is the side that clicks.
        const ratio = g.box.w / g.box.h;
        if (Math.abs(w - g.box.w) > Math.abs(h - g.box.h)) h = w / ratio;
        else w = h * ratio;
        // The follower can land outside a limit the dragged side never reached,
        // and clamping only the offender would change the ratio - the single
        // thing this branch exists to hold. So the pair is rescaled together.
        // Shrink first and grow second, so that on the extreme shape where both
        // limits bind at once it is the floor that survives: a box too large is
        // a nuisance, a box too small cannot be grabbed to undo it.
        let k = Math.min(1, MAX_SIZE / Math.max(w, h));
        k = Math.max(k, MIN_SIZE / Math.min(w, h));
        w *= k;
        h *= k;
      }
      // A note may not be dragged smaller than its own text. The floor is
      // measured at the width being proposed, not the one on screen, because
      // narrowing a note rewraps it and makes it *taller* - so pulling a side
      // in can push the bottom out, which is the honest answer.
      //
      // This runs after the limits above and is allowed to overrule the ceiling
      // on the way up, because a note taller than MAX_SIZE is only unusual
      // whereas a note with its last paragraph cut off is wrong. It can only
      // ever raise the height, so it never threatens the floor.
      const it = byId(g.id);
      if (it.type === 'note') {
        const floor = noteFloor(g.id, w);
        if (floor > h) {
          h = floor;
          // The height was forced, so the aspect lock no longer holds and the
          // centre has to be recomputed from the height we actually got.
          if (!signY) return applyGeom([{ id: g.id, x: g.box.x + signX * (w - g.box.w) / 2, y: g.box.y, w, h, rot: it.rot, z: it.z }]);
        }
      }
      // The opposite edge stays put, so the centre shifts by half the growth -
      // and on the axis an edge handle doesn't touch, signY is 0 and the item
      // grows symmetrically about its centre, which is what an aspect-locked
      // side drag should do.
      applyGeom([{
        id: g.id,
        x: g.box.x + signX * (w - g.box.w) / 2,
        y: g.box.y + signY * (h - g.box.h) / 2,
        w, h, rot: it.rot, z: it.z,
      }]);
    }
  });

  const endPointer = e => {
    cancelPress();
    pointers.delete(e.pointerId);
    if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
    if (!g) return;
    if (g.kind === 'pinch' && pointers.size >= 1) {
      // One finger lifted mid-pinch: fall back to a pan with the survivor.
      const [p] = [...pointers.values()];
      g = { kind: 'pan', lastX: p.x, lastY: p.y };
      return;
    }
    finishGesture();
    setPanCursor();
  };
  el.addEventListener('pointerup', endPointer);
  el.addEventListener('pointercancel', endPointer);

  function finishGesture() {
    if (!g) return;
    if (g.kind === 'marquee') marquee.hidden = true;
    if (g.kind === 'move' && g.moved) commitGeom('Move', g.before);
    if (g.kind === 'resize') commitGeom('Resize', g.before);
    el.classList.remove('is-panning');
    g = null;
    syncItems();
  }

  /** Drop the gesture without committing (used when a pinch takes over). */
  function abortGesture() {
    if (!g) return;
    if (g.kind === 'move' && g.moved) commitGeom('Move', g.before);
    if (g.kind === 'resize') commitGeom('Resize', g.before);
    if (g.kind === 'marquee') marquee.hidden = true;
    el.classList.remove('is-panning');
    g = null;
  }

  // ---- wheel ------------------------------------------------------------

  el.addEventListener('wheel', e => {
    e.preventDefault();
    // deltaMode 1 = lines, 2 = pages: normalise to something pixel-ish.
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? vp.height : 1;
    if (e.shiftKey && !e.ctrlKey) {
      vp.panByScreen(-e.deltaY * scale, 0);
      return;
    }
    const dy = e.deltaY * scale;
    vp.zoomAt(e.clientX, e.clientY, Math.exp(-clamp(dy, -400, 400) * 0.0016));
  }, { passive: false });

  // ---- double click -----------------------------------------------------

  el.addEventListener('dblclick', e => {
    const id = itemIdFromEvent(e.target);
    if (!id) { cmds.fit(); return; }
    const it = byId(id);
    if (!it) return;
    // Video used to be a case here, toggling playback - the only way a clip
    // could be played at all, and an invisible one. Now that a video carries a
    // play button of its own it goes back to meaning what a double click means
    // on everything else on the board, which is zoom to fit. One gesture, one
    // meaning, and the special case disappears.
    if (it.type === 'note') cmds.editNote(id);
    else vp.fit([it], 120, travelMs());
  });

  // ---- keyboard ---------------------------------------------------------

  const typingInto = t =>
    t instanceof HTMLElement &&
    (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

  /**
   * Something that answers to the keyboard on its own.
   *
   * Space activates a focused button and a focused link, and the canvas took
   * that key unconditionally - so tabbing to Save and pressing Space entered
   * pan mode instead of saving, and preventDefault() meant the button never
   * heard about it. A keyboard user could reach every control in the sidebar
   * and operate none of them.
   */
  const nativeKeyTarget = t =>
    t instanceof HTMLElement && !!t.closest('button, a[href], summary, [role="button"]');

  addEventListener('keydown', e => {
    if (typingInto(e.target)) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;

    // Let a focused control have its own keys. The shortcuts with a modifier
    // are still ours - Ctrl+S means save wherever the focus happens to be.
    if (!mod && nativeKeyTarget(e.target) && (e.code === 'Space' || e.key === 'Enter')) return;

    if (e.code === 'Space' && !spaceDown) {
      spaceDown = true;
      setPanCursor();
      e.preventDefault();
      return;
    }
    if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); cmds.selectAll(); return; }
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? cmds.redo() : cmds.undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); cmds.redo(); return; }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); cmds.duplicate(); return; }
    // Ctrl+S is the cheap one - keep this, in the browser. Ctrl+Shift+S is the
    // deliberate one, and writes a file.
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (e.shiftKey) cmds.export(); else cmds.save();
      return;
    }
    if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); cmds.open(); return; }
    if (mod) return;

    switch (e.key) {
      case 'Delete': case 'Backspace': cmds.deleteSelection(); e.preventDefault(); break;
      // One item only: a rename has to put the caret somewhere, and a group
      // selection has no single name to put it in.
      case 'F2': if (selection.size === 1) { editItemName([...selection][0]); e.preventDefault(); } break;
      case '0': cmds.recenter(); break;
      case 'f': case 'F': cmds.fit(); break;
      case '+': case '=': vp.zoomBy(1.25, zoomMs()); break;
      case '-': case '_': vp.zoomBy(1 / 1.25, zoomMs()); break;
      case 'Escape': clearSelection(); cmds.closeSidebar(); break;
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown':
        nudge(e);
        break;
    }
  });

  addEventListener('keyup', e => {
    if (e.code === 'Space') { spaceDown = false; setPanCursor(); }
  });
  // A blur (alt-tab) never delivers the keyup, which would leave pan mode stuck.
  addEventListener('blur', () => { spaceDown = false; setPanCursor(); });

  function nudge(e) {
    if (!selection.size) return;
    e.preventDefault();
    const step = e.shiftKey ? gridStep(board.settings.gridStep, vp.zoom) : 1;
    const dx = (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0) * step;
    const dy = (e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0) * step;
    // The arrow keys are a drag by another route, so they carry the same stuck
    // notes. No z-bump here: a nudge does not raise anything, and the pair are
    // already in the right order relative to each other.
    const before = snapshotGeom([...selection, ...stuckFollowers(selection)]);
    applyGeom(before.map(b => ({ ...b, x: b.x + dx, y: b.y + dy })));
    commitGeom('Nudge', before);
  }

  // ---- clipboard --------------------------------------------------------
  //
  // The real copy/cut/paste events, not a Ctrl+C branch in the keydown handler
  // above, and two things follow from that. A `copy` handler is the only place
  // the system clipboard can be written synchronously and without asking
  // permission, which is what lets a copy leave the receipt that decides the
  // next paste (see clipboardHasOurs in state.js). And the browser only sends
  // these where they belong, so a note being edited or a name being typed keeps
  // the browser's own copy and paste for nothing - the same bargain the
  // `widget` branch in pointerdown makes for the pointer.
  //
  // import/drop.js listens for `paste` too, to bring images, files and text in
  // from outside. This one is registered first, because main.js calls
  // initInput() before initDrop(), and stops the event dead the moment it
  // claims it - so exactly one of the two ever acts on a given paste.

  /** A clipboard gesture is ours only when the canvas, not a field, has focus. */
  const canClip = e => !typingInto(e.target) && !!selection.size;

  addEventListener('copy', e => {
    if (!canClip(e)) return;
    const text = copyItems(selection);
    if (!text) return;
    copiedFrom = hover;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', text);
  });

  addEventListener('cut', e => {
    if (!canClip(e)) return;
    const text = cutItems(selection);
    if (!text) return;
    copiedFrom = hover;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', text);
  });

  addEventListener('paste', e => {
    if (typingInto(e.target) || !clipboardSize()) return;
    const text = e.clipboardData?.getData('text/plain') || '';
    const files = e.clipboardData?.files;
    // Ours wins in two cases and no others. Either the system clipboard still
    // carries the receipt our copy left on it, meaning nothing has been copied
    // anywhere since - or it carries nothing at all, which is what a browser
    // that refused to let us write the receipt looks like, and is anyway the
    // one situation where a paste can mean nothing else. Anything else on it
    // was put there after our copy, and the newer thing is the one meant.
    if (!clipboardHasOurs(text) && (files?.length || text.trim())) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const copies = pasteItems(pasteAt());
    // Selected afterwards, so the copies are what a following nudge, drag or
    // second Ctrl+D acts on - and so the eye is told where the paste landed.
    if (copies.length) select(copies.map(i => i.id));
  });

  /**
   * How far the cursor has to have travelled since the copy before the paste
   * follows it, in screen pixels. Small, because moving the mouse at all is
   * already deliberate; not zero, because a mouse drifts a pixel or two under
   * a hand that is only reaching for Ctrl+V, and a paste that jumped for that
   * would be worse than one that never followed at all.
   */
  const MOVED_ENOUGH = 24;

  /**
   * Where a paste should land, in three cases.
   *
   * Under the cursor, if the cursor has gone somewhere since the copy was
   * taken. Moving the mouse and then pasting is the plainest way there is of
   * saying "put it here", and it costs nothing to answer.
   *
   * Otherwise nothing, meaning "beside the original" - unless the box the copy
   * came from is nowhere in view, in which case the middle of the screen,
   * because a paste you cannot see is indistinguishable from one that failed.
   *
   * A device with no cursor never reaches the first case: `hover` stays null,
   * and the other two are what it had before.
   */
  function pasteAt() {
    if (hover && copiedFrom && Math.hypot(hover.x - copiedFrom.x, hover.y - copiedFrom.y) > MOVED_ENOUGH) {
      return vp.toWorld(hover.x, hover.y);
    }
    const box = clipboardBounds();
    const r = vp.visibleRect(0);
    const inView = box && box.x1 >= r.x0 && box.x0 <= r.x1 &&
                          box.y1 >= r.y0 && box.y0 <= r.y1;
    return inView ? null : vp.toWorld(vp.left + vp.cx, vp.top + vp.cy);
  }

  // The canvas owns the right-click slot: a board's useful actions are spatial,
  // and the browser's menu can't express any of them.
  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    openMenuAt(e.clientX, e.clientY, itemIdFromEvent(e.target));
  });

  function openMenuAt(x, y, id) {
    // Opening outside the selection retargets it, the way every file manager
    // behaves; opening inside one leaves the group intact.
    if (id && !selection.has(id)) select([id]);
    if (!id) clearSelection();
    cmds.contextMenu(x, y, id, selection.size);
  }
}
