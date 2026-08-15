# Responsive Layout Settings

Desktop and Mobile share board content, but each layout owns its geometry,
arrangement, and settings. Switching layouts saves the current profile before
activating the other one.

These values cross the layout boundary:

- the named palette and its color tokens;
- whether the palette is automatic/photo-derived; and
- whimsy;
- typography; and
- installed custom fonts.

Radius, density, grid ink, sidebar width, grid settings, scale, units, HUD
visibility, spacing, and arrangement remain local to the selected layout. The
`mobileColumns` setting is stored only as a meaningful choice in the Mobile
profile and defaults to 6. Paper and its
controls are Desktop-only; Mobile always uses `paper: ""`, the same value
`DEFAULT_SETTINGS` and the None option carry. `setSetting()` refuses
`paper`, `paperLandscape` and `paperResize` outright while Mobile is active,
and the panel takes those controls down — the refusal is the guarantee,
the hiding is only the manners.

## Spacing

Both layouts have one, and they mean the same thing — the gap left between two
neighbouring cards — but they are spent differently. Desktop's is handed to
`arrange()` and so is a rule for the next import or Rearrange; nothing moves
until one of those happens. Mobile's is added to the lattice seam on all four
sides of every card and to the room each one claims in the column, so moving it
repacks the board there and then (`repackMobileBoard()`).

Mobile's default is **0**, and a Mobile profile derived from a Desktop-shaped
file is forced to 0 on the way in. That is a migration, not a rule: top-level
`settings` describes Desktop, so without it every older board would open on a
phone with Desktop's 12px gap it was never saved with. A file that carries its
own `layouts.mobile.settings.spacing` keeps it.

## Arrangement

The two layouts read from different catalogues, because they are answering
different questions. Desktop picks a **shape** — spiral, grid rings, masonry and
the rest of `ARRANGEMENTS`. Mobile packs a column and throws every computed
position away, so the only thing left to choose is the **order** the packer
meets things in: `MOBILE_ARRANGEMENTS`, which is `fit`, `free`, `date`, `type`,
`tag`, `name` and `shuffle`.

`tag` is Desktop's with the page taken away, the way `date` and `type` are: a
column has no blocks to put side by side, so what carries over is the grouping —
everything with one tag together, then the next, untagged last. This paragraph
listed six and the code has carried seven for some time; the code is right, and
a spec that names six is a spec that will be used to argue the seventh away.

`free`, `date` and `type` are deliberately the same id in both, so a board
switched to Mobile and back keeps the setting it had. Anything else stored for
Mobile is read through `mobileArrangement()`: `scatter` becomes `shuffle`, and
the three that are pure geometry — spiral, grid rings, masonry — become `fit`,
which is also what every board written before the split carries. Nothing is
rewritten on load; the stored id stays whatever it was until the user picks
something.

New `.mbrd` data stores responsive layouts as objects:

```json
{
  "layouts": {
    "desktop": {
      "items": [],
      "settings": { "gridStep": 64, "snap": false },
      "arrangement": "spiral"
    },
    "mobile": {
      "items": [],
      "settings": { "gridStep": 64, "snap": true, "mobileColumns": 8 },
      "arrangement": "grid"
    }
  }
}
```

The top-level `settings`, `arrangement`, and `items` fields continue to describe
Desktop for older readers. The loader also accepts the earlier responsive
schema where `layouts.desktop` and `layouts.mobile` were item arrays.
