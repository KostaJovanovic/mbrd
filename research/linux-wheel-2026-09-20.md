# The wheel that pans on Linux — 20 September 2026

Reported from the maintainer's Linux machine: Chromium, Wayland session, a
mouse with a wheel. **Scrolling pans the board instead of zooming it.** Click
outside the window first and the same wheel zooms, and zooms very fast.

**Nothing here is measured.** No deltas were recorded from that machine, so
everything below is reasoning from `canvas/input.ts` and from what Chromium is
known to do on Linux. That is the first thing to fix if this is picked up: one
line in the console over the board, a notch focused and a notch unfocused, and
the guesswork stops.

```js
addEventListener('wheel', e => console.log(e.deltaMode, e.deltaX, e.deltaY, e.ctrlKey),
  { capture: true, passive: true })
```

## Why it happens

`classifyWheel()` (`canvas/input.ts`) guesses the device from one event:

```
if (e.deltaMode !== 0) return 'zoom';                  // Firefox: lines → mouse
if (dx !== 0 || !Number.isInteger(dy)) return 'pan';   // fractional → pad
return Math.abs(dy) < WHEEL_NOTCH ? 'pan' : 'zoom';    // WHEEL_NOTCH = 40
```

All three tests were calibrated on 100–120px notches. Chromium's notch on Linux
is 53px, and with **high-resolution wheel scrolling** — the default path on
Wayland, and on X11 with libinput ≥ 1.19 — one detent is delivered as several
*fractional* sub-notch deltas (53 × v/120 px, from `wl_pointer.axis_value120`).
Each of those trips the fractional veto and the under-a-notch test, so a wheel is
read as a touchpad and the board pans.

The unfocused half is the same fact from the other side: a background window gets
its notches coalesced into one large integer delta. Over a notch, so it zooms —
and large enough to reach `WHEEL_MAX_STEP` (400), which is `exp(400 × 0.0016)` =
**1.9× per event**. That is the "very fast".

## Why it cannot simply be detected better

Chromium exposes nothing that separates a hi-res wheel from a touchpad. Both are
`deltaMode: 0` carrying fractional pixels. The classic escape — the legacy
`wheelDeltaY / deltaY` ratio, 3 for a trackpad against 120/100 for a wheel — does
not work here: on Linux `ui::MouseWheelEvent::kWheelDelta` is 53 for *both*
sources, so both report the same 120/53 ≈ 2.264. There is no signal left.

So the detection can be made better but not made right, and the honest shape of a
fix is a preference that always works plus a heuristic that is best-effort.

## The fix, if it is wanted

**1. A Scroll preference, which is the part that actually guarantees anything.**
`canvas/input.ts` owns a `WheelMode` of `'auto' | 'zoom' | 'pan'`, in the shape
`setSoundLevel()` uses in `cuelume/engine.ts`, persisted through `prefs.ts` —
`canvas/audio.ts` already imports it, so the layering graph is untouched.
`readWheel()` takes it as a fourth parameter rather than reading the pref itself,
which keeps it the pure function its header promises. The forced modes apply only
to the plain branch: a pinch, Shift+scroll and Ctrl+scroll are explicit gestures
and keep their meanings. One `picker` in `ui/settings-schema.ts` on the System
tab, per device, never inside a `.mbrd` — the reason the Quality section gives.

**2. `WHEEL_MAX_STEP` from 400 to about 120**, one notch and a little. It can only
ever reduce a step, so nothing that works today changes, and the coalesced
unfocused delta stops being a leap. A pinch delta is single figures and never
reaches the clamp, so `PINCH_ZOOM_RATE` is unaffected.

**3. One detection rule that is safe without a recording.** A hi-res detent is a
short run of *identical* fractional deltas with no sideways component at all,
inside a frame or two. A finger does not produce two identical fractional deltas
in a row, and a swipe starts slow — `tests/input.test.js` already asserts that.
So: track the burst's first timeStamp, the signed sum of `dy`, whether any `dx`
has ever been non-zero, and whether every `|dy|` so far is the same number. Relatch
`pan` → `zoom` only when all four hold — fresh burst (~24ms), never any `dx`, two
or more events of identical magnitude, accumulated `|dy|` past `WHEEL_NOTCH`.

The events that already panned have to be given back or each notch jitters: an
optional `undo: {dx, dy}` on `WheelAction`, spent through `vp.panByScreen()` before
`vp.zoomAt()`. Both land in one frame, so the board is never painted in the
intermediate position. `resetWheelKind()` clears the new burst fields too.

If Chromium instead spreads a detent across frames, or sends it as one sub-notch
event, the rule never fires and the preference carries the fix. That is the
intended failure mode: **a touchpad never satisfies all four conditions at once**,
so this cannot make the good case worse.

## What a test would have to say

In the wheel block of `tests/input.test.js`: the two forced modes, and that pinch,
Shift and Ctrl still win over both; a hi-res detent of eight events of 6.625px,
2ms apart, no `dx` → `zoom` with the right `undo`; a swipe of *varying* magnitudes
summing to the same total → still `pan`, which is the guard doing its job; and one
enormous delta zooming no more than about 1.25×. Every existing case stands
unchanged — `WHEEL_NOTCH - 1` alone is still `pan`, and the 3px-then-100px burst
stays `pan` because its magnitudes differ.
