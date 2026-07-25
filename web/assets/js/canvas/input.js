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
//   drag an item ................ move the whole selection
//   drag a corner grip .......... resize (aspect-locked for media, shift to free it)
//   wheel ....................... zoom to cursor;  shift+wheel pans horizontally
//   two fingers ................. pan + pinch zoom

import { clamp } from '../util.js';
import {
  board, byId, selection, select, clearSelection, topZ,
  snapshotGeom, applyGeom, commitGeom, bus,
} from '../state.js';
import { zoomMs, travelMs } from './viewport.js';
import { itemIdFromEvent, ensureMounted, sync as syncItems } from './items.js';
import { gridStep } from './grid.js';

const DRAG_SLOP = 3;      // screen px before a press becomes a drag
const MIN_SIZE = 24;      // world px - below this an item is unclickable

export function initInput(vp, cmds) {
  const el = vp.el;
  const marquee = document.getElementById('marquee');

  /** pointerId -> latest client position, for multi-touch bookkeeping. */
  const pointers = new Map();
  let g = null;            // the active gesture
  let spaceDown = false;

  // ---- helpers ----------------------------------------------------------

  const snapVal = v => {
    if (!board.settings.snap) return v;
    const step = gridStep(board.settings.gridStep, vp.zoom);
    return Math.round(v / step) * step;
  };

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
      .filter(i => i.x + i.w / 2 >= x0 && i.x - i.w / 2 <= x1 &&
                   i.y + i.h / 2 >= y0 && i.y - i.h / 2 <= y1)
      .map(i => i.id);
    select(hit, g.additive);
  }

  function startMove(e, id) {
    // Snapshot before raising, so the z-bump rides along in the same undo entry.
    const before = snapshotGeom(selection);
    let z = topZ();
    for (const sid of selection) byId(sid).z = ++z;
    bus.emit('geom', [...selection]);
    const start = vp.toWorld(e.clientX, e.clientY);
    g = {
      kind: 'move', id, before, start,
      origin: before.map(b => ({ id: b.id, x: b.x, y: b.y })),
      moved: false,
    };
    for (const sid of selection) ensureMounted(sid);
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
    const widget = target?.closest('audio, video[controls], input, button, a, [contenteditable="true"], [contenteditable="plaintext-only"]');

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
    setPanCursor();
  });

  el.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
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
      let w = signX ? Math.max(MIN_SIZE, g.box.w + dx * signX) : g.box.w;
      let h = signY ? Math.max(MIN_SIZE, g.box.h + dy * signY) : g.box.h;
      if (g.lockAspect !== e.shiftKey) {          // XOR: shift inverts the default
        const ratio = g.box.w / g.box.h;
        if (Math.abs(w - g.box.w) > Math.abs(h - g.box.h)) h = w / ratio;
        else w = h * ratio;
      }
      // The opposite edge stays put, so the centre shifts by half the growth -
      // and on the axis an edge handle doesn't touch, signY is 0 and the item
      // grows symmetrically about its centre, which is what an aspect-locked
      // side drag should do.
      const it = byId(g.id);
      applyGeom([{
        id: g.id,
        x: g.box.x + signX * (w - g.box.w) / 2,
        y: g.box.y + signY * (h - g.box.h) / 2,
        w, h, rot: it.rot, z: it.z,
      }]);
    }
  });

  const endPointer = e => {
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
    if (it.type === 'note') cmds.editNote(id);
    else if (it.type === 'video') {
      const v = e.target.closest('.item')?.querySelector('video');
      if (v) v.paused ? v.play().catch(() => {}) : v.pause();
    } else {
      vp.fit([it], 120, travelMs());
    }
  });

  // ---- keyboard ---------------------------------------------------------

  const typingInto = t =>
    t instanceof HTMLElement &&
    (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

  addEventListener('keydown', e => {
    if (typingInto(e.target)) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;

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
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); cmds.save(); return; }
    if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); cmds.open(); return; }
    if (mod) return;

    switch (e.key) {
      case 'Delete': case 'Backspace': cmds.deleteSelection(); e.preventDefault(); break;
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
    const before = snapshotGeom(selection);
    applyGeom(before.map(b => ({ ...b, x: b.x + dx, y: b.y + dy })));
    commitGeom('Nudge', before);
  }

  // The canvas owns the right-click slot: a board's useful actions are spatial,
  // and the browser's menu can't express any of them.
  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    const id = itemIdFromEvent(e.target);
    // Right-clicking outside the selection retargets it, the way every file
    // manager behaves; right-clicking inside one leaves the group intact.
    if (id && !selection.has(id)) select([id]);
    if (!id) clearSelection();
    cmds.contextMenu(e.clientX, e.clientY, id, selection.size);
  });
}
