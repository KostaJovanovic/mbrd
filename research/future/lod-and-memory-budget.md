# A level-of-detail proxy, and a memory budget behind it

Not started. Lifted out of `research/old/2026-07-30-perf-plan.md` (A4 and A5)
when the rest of that plan closed on 2026-07-31, because both are gated on a
measurement nobody has taken yet and neither should be built without it.

## Why these are still open

The perf plan's Part A was about a crash: on an iPhone, framing a whole board of
fifty items killed the tab. Three of its five fixes shipped and are the reason
that is no longer the headline —

- **A1**, photos mount a card-sized WebP copy instead of the full original
  (`canvas/display.js`),
- **A2**, `discard()` clears an `<img>`'s `src` so the decode is released,
- **A3**, videos mount source-less on touch and attach a source on first play.

A4 and A5 are what comes *after* those, and the plan is explicit that they are
conditional on what the numbers look like once they are in: A5 says "do after
A1–A4 and measure whether it is still needed", and A4's whole case rests on
whether memory still climbs with item count once the display copies are
bounded. That number has never been read on the device that crashes.

So the sequence is unchanged and the next step is not code:

1. Open the board on the iPhone at `.../#perf`. The profiler arms itself from
   the hash and puts a readout on the glass, which is exactly why it was built
   that way — a touch device with no console can be measured without a cable.
2. On a ~50-item board of photos and video, zoom out to frame the whole thing
   and hold it. Read `mbrd.perf.report()`: median and p95 fps, and from
   `viewStats()` the mounted-node, live-video and decoded-image-MB counts.
3. The question that decides both items: **does decoded-MB plateau, or does it
   still track item count?** If it plateaus, A1–A3 did the job and neither of
   these is needed. If it climbs, A4 is the fix and A5 is its safety net.

## A4 — Level-of-detail proxy at far zoom

Below a zoom threshold, stop mounting heavy media DOM at all and draw a cheap
proxy: the thumbnail `<img>`, or at extreme zoom-out a single canvas blit of
coloured rectangles keyed to each item's dominant colour. This bounds memory and
layer count by *screen area* rather than by item count, which is the only shape
of fix that makes "see the whole board" safe however large the board grows.

The hooks exist. `stillZoom()` / `lodZoom()` in `canvas/viewport.js` and the
`#world.is-stilled` / `.zoom-far` machinery already drop card chrome and freeze
GIFs at the same threshold, and `canvas/stills.js` already captures a still per
card. What is missing is the step past "hide the chrome" to "do not mount the
media".

Risk to weigh before starting: this changes what is in the DOM at a zoom
threshold, so it interacts with culling (`canvas/items.js sync`), with the media
cache that deliberately keeps mid-playback video mounted, and with the display
copies from A1. It is not a CSS rule.

## A5 — Hard memory budget with graceful degradation

Track live decoded bytes — `viewStats()` already sums
`naturalWidth × naturalHeight × 4` over mounted images and counts live videos —
and when it crosses a device-aware ceiling, force everything past the nearest
items down to thumbnails or proxies even when the zoom has not reached the LOD
threshold. A net, so a pathological board degrades instead of dying.

Lower priority than A4 by construction: it is the fallback for boards A4 does
not already handle, so it cannot be sized until A4 exists.

## What is already true

Do not re-derive these; they landed in the round this document came out of.

- The profiler is trustworthy. `report()`'s median-NaN bug is fixed, the cull
  hot path is timed (`cullProfile`), and the HUD carries the memory readout
  (`viewStats`).
- The per-frame work in Part B is done: sync is throttled during motion, shadow
  twins drop at far zoom, the grid skips sub-pixel repaints, and the note
  toolbar no longer forces a layout per frame.
