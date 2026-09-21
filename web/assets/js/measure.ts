// Ties the board's unitless float coordinates to real-world measurements via
// one number, `settings.scale` (world units per millimetre — millimetre so
// every conversion divides rather than multiplies). `settings.units` only
// picks the display names; it changes no geometry.
//
// Pure: no DOM, no state, no board — callers pass both settings in. Sits at
// the bottom of the layering beside util.ts and geometry.ts.

/** The one hard fact in this file. Everything imperial is derived from it. */
export const MM_PER_INCH = 25.4;
const MM_PER_FOOT = MM_PER_INCH * 12;

/**
 * CSS's own definition of an inch. Exactly 96 px, by the spec, and it is the
 * only bridge that exists between a browser's coordinate system and the world -
 * there is no API for the physical size of a display, and `screen.width` counts
 * pixels, which is the question restated rather than answered.
 *
 * "Exactly" in the spec and "approximately" on the glass, and the gap is worth
 * naming: a browser reports 96 px to the inch whatever panel it is running on,
 * so on a 92 dpi monitor a nominal inch is about 4% over and on a phone it is
 * off by a great deal more. So this is a unit conversion and not a measurement
 * of anybody's screen. Its one remaining reader wants exactly that much -
 * MIN_PX_TOUCH in canvas/grid.ts, a finger-sized floor on how close two lattice
 * dots may be drawn - and the default scale below no longer derives from it. A
 * board that is *about* physical objects is measured from one of them, which is
 * what the paper corners and "Set from selection" are for.
 */
export const PX_PER_INCH = 96;

/**
 * The default scale: a sheet of A4 is 1325 board units down its long side.
 *
 * A board nobody has measured still has to say *something*, and this file has
 * said three things in turn. "One unit is one millimetre" came first, and made
 * a dropped photograph a 32 cm print. CSS's own inch came next and had the
 * better argument: one world unit is one CSS pixel at 1:1 (see viewport.ts), so
 * at 100% zoom an A4 outline was an A4 you could hold up against the screen,
 * and the zoom readout was a percentage of something rather than of nothing.
 *
 * This is the third, and it gives that up. A4 comes out 1325 x 937, and 100%
 * zoom shows it about 18% over life size - life size put the sheet at 1123
 * units, which is smaller than a board is worked on.
 *
 * Picked rather than derived, and the honest thing is to say so. The argument
 * the last one had was precisely that its number was nobody's choice; dressing
 * a chosen number in those clothes would be the arbitrary answer wearing them,
 * which is what "one unit is one millimetre" already was.
 *
 * Nothing downstream reads the number: every measurement in the app goes
 * through toMm() and toUnits(), and a board that is about something real is
 * measured from it rather than inheriting this.
 */
const A4_LONG_MM = 297;        // and the short side is 210 - see PAPERS below
const A4_LONG_UNITS = 1325;
export const DEFAULT_SCALE = A4_LONG_UNITS / A4_LONG_MM;

/**
 * Guard rails. A scale outside these is a typo, not a board.
 *
 * Wide on purpose. These exist to stop a hand-edited file turning every readout
 * into Infinity, and for nothing else - a board about a tray of jewellery is
 * entitled to a scale that measures it, and a board about a building site is
 * entitled to the other end. How *legible* the lattice is at a given scale is a
 * rendering question with a rendering answer; see MIN_PX in canvas/grid.ts,
 * which sets a floor on how close two dots may be drawn rather than on what the
 * board is allowed to mean.
 */
export const MIN_SCALE = 0.001;   // 1 unit = 1 metre
export const MAX_SCALE = 1000;    // 1000 units = 1 millimetre

// `unknown` in, a scale out. This is the door a hand-edited file comes through
// - board-schema.ts hands it whatever `settings.scale` held - so the coercion
// is the function's job rather than the caller's, and every non-number lands on
// the default the same way a wild number does.
export const clampScale = (n: unknown) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.min(Math.max(v, MIN_SCALE), MAX_SCALE) : DEFAULT_SCALE;
};

/** World units -> millimetres, and back. The only two conversions that exist. */
export const toMm = (units: number, scale: unknown) => units / clampScale(scale);
export const toUnits = (mm: number, scale: unknown) => mm * clampScale(scale);

/**
 * A length in millimetres, written the way somebody would say it.
 *
 * The unit is chosen from the magnitude rather than fixed, because a board can
 * hold a 4 mm gap and a 6 m wall at once and there is no single unit that reads
 * well for both - "0.004 m" and "6000 mm" are each the same number said badly.
 * The thresholds are where the spoken form actually changes: under a centimetre
 * people say millimetres, past a metre they say metres, and everything between
 * is centimetres.
 *
 * Three significant figures at most, and trailing zeros dropped, so a readout
 * that updates as you drag changes width as little as possible.
 */
export function formatMm(mm: number, system = 'metric') {
  const { value, unit } = partsMm(mm, system);
  return `${value} ${unit}`;
}

/**
 * The chosen value and its unit name, kept apart rather than joined into a
 * string. formatMm() joins them for display; formatSize() compares the `unit`
 * fields directly, which is the whole reason this exists - recovering the unit
 * by re-parsing an already-formatted string broke on "4 ft 3 in", whose first
 * space is not where its unit begins.
 */
function partsMm(mm: number, system: string) {
  const neg = mm < 0;
  const { value, unit } = system === 'imperial' ? imperial(Math.abs(mm)) : metric(Math.abs(mm));
  return { value: neg ? '-' + value : value, unit };
}

function metric(mm: number) {
  if (mm < 10) return { value: trim(mm, mm < 1 ? 2 : 1), unit: 'mm' };
  if (mm < 1000) return { value: trim(mm / 10, mm < 100 ? 2 : 1), unit: 'cm' };
  return { value: trim(mm / 1000, mm < 10000 ? 2 : 1), unit: 'm' };
}

/**
 * Feet and inches, not decimal feet.
 *
 * "4 ft 3 in" is how the measurement is spoken and written on a tape; "4.25 ft"
 * is how it is stored. Under a foot the feet are dropped rather than shown as a
 * zero, and a whole number of feet drops the inches for the same reason.
 */
function imperial(mm: number) {
  // Rounded to what will be printed *before* the shape is chosen from it, and
  // that ordering is the whole of this function's difficulty. Twelve inches is
  // 304.8 mm, which in binary floating point divides back to 11.999999999999998
  // - so deciding on the raw value prints exactly one foot as "12 in", which is
  // not a length anybody writes. Every threshold below reads the shown number.
  const places = mm < MM_PER_INCH ? 3 : 2;
  const shown = Number((mm / MM_PER_INCH).toFixed(places));
  if (shown < 12) return { value: String(shown), unit: 'in' };
  const feet = Math.floor(shown / 12);
  const rest = Number((shown - feet * 12).toFixed(1));
  // And the remainder can round up to a full twelve on its own, for the same
  // reason and with the same answer: carry it.
  if (rest >= 12) return { value: String(feet + 1), unit: 'ft' };
  // The compound form keeps its trailing unit as the `unit` field, so two
  // feet-and-inches lengths that share it collapse the way two centimetres do.
  return rest ? { value: `${feet} ft ${rest}`, unit: 'in' } : { value: String(feet), unit: 'ft' };
}

/** Fixed to `places`, then stripped of the zeros that adds. */
function trim(n: number, places: number) {
  return String(Number(n.toFixed(places)));
}

/** A length in world units, written for a person. The everyday entry point. */
export const formatLength = (units: number, scale: unknown, system?: string) =>
  formatMm(toMm(units, scale), system);

/** "32 x 24 cm" - an item's real size, the pair sharing one unit name. */
export function formatSize(w: number, h: number, scale: unknown, system?: string) {
  const a = partsMm(toMm(w, scale), system ?? 'metric');
  const b = partsMm(toMm(h, scale), system ?? 'metric');
  // Said once when both halves agree on it, which is nearly always. When they
  // do not - a 9 mm by 4 cm sliver - both keep their own rather than one being
  // converted into a unit that reads badly for it. Compared as unit fields, not
  // recovered from the printed text: see partsMm().
  return a.unit === b.unit
    ? `${a.value} × ${b.value} ${b.unit}`
    : `${a.value} ${a.unit} × ${b.value} ${b.unit}`;
}

/**
 * The scale that makes `units` measure `mm`.
 *
 * The way a board actually gets calibrated: point at something whose real size
 * you know - a photograph of a chair, a floor plan, a door - say how wide it
 * really is, and every other measurement on the board follows from it. Typing a
 * units-per-millimetre figure is the same thing said in a language nobody
 * thinks in.
 */
export const scaleFrom = (units: number, mm: number) =>
  clampScale(mm > 0 && units > 0 ? units / mm : DEFAULT_SCALE);

// ---------------------------------------------------------------------------
// Standard sheets
// ---------------------------------------------------------------------------

/**
 * The paper sizes a board can draw an outline of, portrait, in millimetres.
 *
 * Here rather than beside the thing that draws them, because a sheet of A4 is a
 * real-world measurement and this is the file that knows about those. The
 * renderer, the sidebar's dropdown and the loader's validation all read this one
 * list, so a size cannot exist in the menu and not in the drawing.
 *
 * Portrait always, with the swap left to the caller: ISO defines each size in
 * one orientation and the other is that one turned, which is exactly what
 * `paperMm()` does. Storing both would be storing the same fact twice.
 *
 * The A series is the whole point of the feature and runs from A6 up to A0 -
 * past A0 nobody is laying out by eye, and below A6 the sheet is a business
 * card. The three North American sizes are there because "A4" is not a size
 * everybody has ever held, and their millimetres are exact conversions of the
 * inch figures that define them, not roundings.
 */
export const PAPERS: { id: string, label: string, mm: [number, number] }[] = [
  { id: 'a0', label: 'A0', mm: [841, 1189] },
  { id: 'a1', label: 'A1', mm: [594, 841] },
  { id: 'a2', label: 'A2', mm: [420, 594] },
  { id: 'a3', label: 'A3', mm: [297, 420] },
  { id: 'a4', label: 'A4', mm: [210, 297] },
  { id: 'a5', label: 'A5', mm: [148, 210] },
  { id: 'a6', label: 'A6', mm: [105, 148] },
  { id: 'letter', label: 'Letter', mm: [215.9, 279.4] },   // 8.5 x 11 in
  { id: 'legal', label: 'Legal', mm: [215.9, 355.6] },     // 8.5 x 14 in
  { id: 'tabloid', label: 'Tabloid', mm: [279.4, 431.8] }, // 11 x 17 in
];

/**
 * One sheet as { w, h, label } in millimetres, or null for "no sheet".
 *
 * Null rather than a throw or a default, because '' is the ordinary value of
 * this setting - most boards have no sheet on them - and because the id can
 * arrive out of somebody else's file naming a size this version has never heard
 * of. Both are the same answer: draw nothing.
 */
export function paperMm(id: string, landscape = false) {
  const sheet = PAPERS.find(p => p.id === id);
  if (!sheet) return null;
  const [w, h] = sheet.mm;
  return landscape ? { w: h, h: w, label: sheet.label } : { w, h, label: sheet.label };
}

/**
 * The steps a scale bar is allowed to be, in millimetres.
 *
 * 1-2-5 per decade, which is the ladder every ruler, axis and map scale has
 * used for a century, for the good reason that the gaps between its rungs are
 * even in the way the eye reads them: each step is roughly two and a half times
 * the last, so no two adjacent choices look the same and none is more than a
 * factor of three from its neighbour.
 *
 * The imperial ladder is not 1-2-5 and cannot be, because the units are not
 * decimal: a bar labelled "2.5 in" is arithmetic, where "1 in", "3 in", "1 ft"
 * are the marks actually printed on a tape measure. So each family gets its own
 * ladder, in millimetres, and the choosing code below does not care which.
 */
const METRIC_STEPS = [1, 2, 5];
const IMPERIAL_MM = [
  MM_PER_INCH / 4, MM_PER_INCH / 2, MM_PER_INCH, MM_PER_INCH * 3, MM_PER_INCH * 6,
  MM_PER_FOOT, MM_PER_FOOT * 3, MM_PER_FOOT * 10, MM_PER_FOOT * 30, MM_PER_FOOT * 100,
  MM_PER_FOOT * 300, MM_PER_FOOT * 1000,
];

/**
 * The longest round length that fits in `maxPx` on screen, as { mm, px }.
 *
 * Longest rather than nearest: a scale bar is read by comparing it against the
 * things beside it, so the useful one is the biggest that still fits its corner.
 * Returns null when even the smallest rung overflows, which is a board zoomed so
 * far in that a quarter-inch spans the window - there is no honest bar to draw
 * there, and the caller hides it rather than drawing a dishonest one.
 */
export function scaleStep(pxPerMm: number, maxPx: number, system = 'metric') {
  if (!(pxPerMm > 0) || !(maxPx > 0)) return null;
  const ladder = system === 'imperial'
    ? IMPERIAL_MM
    : decades(maxPx / pxPerMm);
  let best: { mm: number, px: number } | null = null;
  for (const mm of ladder) {
    const px = mm * pxPerMm;
    if (px > maxPx) break;
    best = { mm, px };
  }
  return best;
}

/**
 * The metric ladder, generated rather than listed, because it has no top and no
 * bottom: a board can be measured in tenths of a millimetre or in kilometres and
 * both want the same 1-2-5 rungs. Built up to the largest length that could fit,
 * so scaleStep() above walks it in order and stops at the first overflow.
 */
function decades(maxMm: number) {
  const out: number[] = [];
  // The ladder has no top, and the *loop* has to. `top` is derived from the
  // argument, so a non-finite maxMm made it Infinity and this ran forever
  // pushing numbers until the tab died. Not reachable today - ui/scalebar.ts
  // bounds pxPerMm through clampScale and the zoom clamps, and the ratio is
  // what arrives here - but "no caller passes that" is the kind of guarantee
  // that holds until somebody adds a caller. Twenty-four decades is from a
  // tenth of a millimetre to well past the diameter of the earth.
  const raw = Math.ceil(Math.log10(Math.max(maxMm, 1)));
  const top = Number.isFinite(raw) ? Math.max(1, Math.min(24, raw)) : 1;
  for (let e = -2; e <= top; e++) {
    const unit = Math.pow(10, e);
    for (const s of METRIC_STEPS) out.push(s * unit);
  }
  return out;
}
