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
visibility, and arrangement remain local to the selected layout. Spacing is a
Desktop-only control; Mobile instead packs items into rectangular spans of its
6- or 8-space grid and keeps the lattice's built-in inset seam. The
`mobileColumns` setting is stored only as a meaningful choice in the Mobile
profile and defaults to 6. Paper and its
controls are Desktop-only; Mobile always uses `paper: ""`, the same value
`DEFAULT_SETTINGS` and the None option carry. `setSetting()` refuses `spacing`,
`paper`, `paperLandscape` and `paperResize` outright while Mobile is active,
and `ui/sidebar.js` takes those controls down — the refusal is the guarantee,
the hiding is only the manners.

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
