// What the mess is and when it counts gone: the mess/tool table, the coarse
// occupancy grid a jet clears, the pressure tank, what a glove will hold, and
// the pairing that strings a cobweb across three cards. Pure - no DOM, no
// canvas, no state.ts - so the whole of the game's arithmetic is testable in
// Node, and the drawing in art.ts stays a drawing.

/** The three tools, in the order they appear in the bar and in the order the
 *  digit keys pick them. Three, and each one is *held*: the bar is where a tool
 *  rests, not a mode switch. */
export const TOOLS = [
  { id: 'glove', label: 'Glove' },
  { id: 'washer', label: 'Pressure washer' },
  { id: 'duster', label: 'Duster' },
] as const;

export type ToolId = typeof TOOLS[number]['id'];

export type MessKind =
  | 'mud' | 'rust' | 'tar'
  | 'leaves' | 'crumbs' | 'gum' | 'paper' | 'cap' | 'dust'
  | 'cobweb';

/** How a mess is drawn and hit, which decides who owns it:
 *  - `field`  a caked layer on one card, washed off by the jet
 *  - `debris` discrete drawn things, picked up by the handful
 *  - `web`    strung across three cards, and owned by none of them */
export type MessFamily = 'field' | 'debris' | 'web';

export type MessDef = {
  tool: ToolId,
  family: MessFamily,
  /** How much of a handful one piece takes. Debris only; a field has none. */
  bulk?: number,
  label: string,
};

export const MESS = {
  mud: { tool: 'washer', family: 'field', label: 'caked mud' },
  rust: { tool: 'washer', family: 'field', label: 'rust' },
  tar: { tool: 'washer', family: 'field', label: 'tar' },
  leaves: { tool: 'glove', family: 'debris', bulk: 1, label: 'leaves' },
  crumbs: { tool: 'glove', family: 'debris', bulk: 1, label: 'crumbs' },
  gum: { tool: 'glove', family: 'debris', bulk: 1, label: 'gum' },
  paper: { tool: 'glove', family: 'debris', bulk: 2, label: 'crumpled paper' },
  cap: { tool: 'glove', family: 'debris', bulk: 1, label: 'a bottle cap' },
  dust: { tool: 'glove', family: 'debris', bulk: 1, label: 'a ball of dust' },
  cobweb: { tool: 'duster', family: 'web', label: 'cobweb' },
} satisfies Record<MessKind, MessDef>;

/** The three caked grimes, weighted as they are dealt: mud is the common one,
 *  tar the one you are pleased to find. */
export const GRIMES: MessKind[] = ['mud', 'mud', 'mud', 'rust', 'rust', 'tar'];

/** The five loose things. */
export const DEBRIS: MessKind[] = ['leaves', 'crumbs', 'gum', 'paper', 'cap', 'dust'];

/** Whether this tool is the one that bites. Everything else is a dull thud. */
export const yieldsTo = (kind: MessKind, tool: ToolId) => MESS[kind].tool === tool;

// ---- tuning -------------------------------------------------------------
// Every rate the game's pace depends on, in one block, because pacing is found
// by playing it and not by reasoning about it. Radii are in world units.

/** Annotated rather than `as const` with assertions inside it: the spans are
 *  handed to randInt() as a pair, and a literal type would make each one its
 *  own two-number tuple that nothing else can be assigned to. */
type Tuning = {
  maxCards: number,
  perPatch: [number, number],
  fewPieces: [number, number],
  grid: number,
  clearAt: number,
  cover: number,
  webGap: number,
  webArea: number,
  webPerCard: number,
  webRoom: number,
  handful: number,
  gumTugs: number,
  grimeChance: number,
  debrisChance: number,
  depth: Record<string, number>,
  reach: Record<ToolId, { radius: number }>,
  jet: readonly JetRow[],
  jetSmoothMs: number,
  tank: { fullMs: number, fadeMs: number, refillMs: number },
};

/** One row of the pressure curve: at this hand speed, this much of the washer's
 *  reach and this much bite per stamp. */
export type JetRow = { speed: number, radius: number, bite: number };

export const TUNING: Tuning = {
  /** Cards that get dirty at all, nearest the centre of the board's bounds. A
   *  500-card board would otherwise be a chore and a frame-rate problem. */
  maxCards: 30,
  /** Things in a patch of the loose stuff that comes in handfuls. */
  perPatch: [4, 10],
  /** And in a patch of the stuff that does not: paper and caps arrive in ones
   *  and twos, because ten crumpled balls on one card is a bin, not a board. */
  fewPieces: [1, 3],
  /** Occupancy cells across a card. 32x32 = 1024 bits per field, which is
   *  cheap to hold and fine-grained enough that a stroke feels like it lands. */
  grid: 32,
  /** Cleared share at which the last specks dissolve on their own. Hunting one
   *  surviving pixel is the opposite of relaxing. */
  clearAt: 0.95,
  /** Share of the grid a dealt field fills. The crust is a layer over the whole
   *  card, edge to edge, so that washing it is a reveal - see art.ts. */
  cover: 1,
  /** Largest gap between any two of a web's three card edges. The strands
   *  themselves may run further than this and may cross a card lying between -
   *  this bounds how tight the cluster is, not how long a strand gets. */
  webGap: 170,
  /** Smallest triangle a web may be spun on, as twice the area on the three
   *  cards' centres - so about a card's width squared. Below it the three are
   *  stacked or in a row, and what draws is a strand doubled over rather than a
   *  web. This is the number that answers "sometimes it is too small". */
  webArea: 30000,
  /** Webs one card may be part of. **One.** Two webs sharing a card put two
   *  hubs and two spirals over the same stretch of board, and what that draws
   *  is not two webs, it is a mess with no shape in it. */
  webPerCard: 1,
  /** How much bigger than its own triangle a web is held to be when asking
   *  whether it clashes with another, so the strands that sag below an edge
   *  still count as the web's own room. */
  webRoom: 1.25,
  /** Pieces the glove holds, by bulk. The glove is the only tool that holds
   *  anything: the duster clears a strand outright, and giving a second tool a
   *  capacity and a shake-out made it a second glove. */
  handful: 5,
  /** Presses gum takes before it comes away. */
  gumTugs: 3,
  /** How often a card is dealt each of the two, independently - so a card can
   *  carry leaves lying on rust, which is where the glove-then-washer order
   *  comes from. */
  grimeChance: 0.7,
  debrisChance: 0.5,
  /** Passes of the jet a cell of each grime takes before it is gone. Thick
   *  things take longer, and tar is the one you settle in for. */
  depth: { mud: 2, rust: 3, tar: 5 },
  /** How wide each tool's touch is. The washer is the narrow one on purpose:
   *  aiming the jet is the play. */
  reach: {
    glove: { radius: 34 },
    washer: { radius: 30 },
    duster: { radius: 44 },
  },
  /** Distance is pressure. A hand held close - moving slowly - is a tight, hard
   *  jet; a sweep is wide and light. Nothing says so in words: slow strokes
   *  simply clean better, and finding that out is the whole of it.
   *
   *  Speed is world units a second. `radius` multiplies reach.washer, `bite`
   *  multiplies the pass a stamp takes. Linear between the rows, flat outside
   *  them.
   *
   *  **The bite has to fall against the square of the radius, not against the
   *  radius.** What a pass takes off is its *area* times its bite: a wider jet
   *  covers more cells and puts each of them under more overlapping stamps, so
   *  the two multiply. Checked against `radius * bite` the curve looked like a
   *  real trade and was not one - the product ran 0.78 / 0.80 / 0.40 on the
   *  square, which is flat from a crawl to a normal sweep, and a sweep covers
   *  twice the ground. Going fast was free and then some.
   *
   *  These are not free numbers. Between two rows both quantities move
   *  linearly, and `r^2 * b` can climb inside a segment even when it falls from
   *  end to end - it did, just past the first row, because `2*r*r'*b` beats
   *  `r^2*b'` while the radius is still small. Holding the derivative negative
   *  across the whole curve is what fixes each row's bite once the one before it
   *  is chosen: at most `0.14 x` the previous bite over the first span, and
   *  `0.3 x` over the second.
   *
   *  The work runs 0.78 / 0.22 / 0.10 - a crawl does three and a half times what
   *  an ordinary sweep does and nearly eight times what a fast one does. A fast
   *  sweep thins mud; it does not finish it. */
  jet: [
    { speed: 40, radius: 0.7, bite: 1.6 },
    { speed: 250, radius: 1, bite: 0.22 },
    { speed: 700, radius: 1.35, bite: 0.055 },
  ],
  /** Smoothing on the speed the curve is read at. Raw pointer speed between two
   *  frames is noise - the jet would flutter between wide and narrow on a hand
   *  that is holding still. */
  jetSmoothMs: 120,
  /** Six seconds of full pressure, two in which it weakens to nothing, and
   *  1.7 to fill again. The rest is not a punishment, it is the beat. */
  tank: { fullMs: 6000, fadeMs: 2000, refillMs: 1700 },
};

// ---- fields -------------------------------------------------------------

/** A caked mess on one card, as the coarse grid that decides when it is gone.
 *  The canvas is what you see; this is what is counted. Reading coverage back
 *  out of the canvas with getImageData would stall the frame on every stroke. */
export type Field = {
  kind: MessKind,
  /** grid x grid, counting down to 0 as the crust comes off. A cell holds how
   *  much more washing it needs, so a stroke thins grime rather than punching a
   *  hole through it - which is the whole difference between washing and
   *  stamping, and the reason one pass over a card is not a clean card.
   *
   *  In **sub-units** of a pass, `SUBS` to the pass - which is why this is a
   *  Uint16Array and not the byte array it was. See SUBS. */
  cells: Uint16Array,
  /** Cells set when it was dealt - the denominator, so a thin crust and a
   *  thick one both finish at the same 95%. */
  total: number,
  left: number,
};

export type Rng = () => number;

export const rand = (rng: Rng, lo: number, hi: number) => lo + rng() * (hi - lo);
export const randInt = (rng: Rng, lo: number, hi: number) => Math.floor(rand(rng, lo, hi + 1));
export const pick = <T>(rng: Rng, from: readonly T[]): T => from[Math.floor(rng() * from.length)]!;

/**
 * Sub-units a cell holds per pass of the jet.
 *
 * **A cell used to hold whole passes, and that is what made a weak jet a
 * stuttering one.** The bite a pass takes is a float - a fast sweep is worth
 * five hundredths of a pass - and an integer grid cannot express that, so it was
 * banked in an accumulator until it crossed a whole unit and then spent all at
 * once. What came out was not a gentler jet, it was the same jet firing one time
 * in eighteen. Sixty-four sub-units to the pass makes every bite down to about
 * 0.015 a real number the grid can hold, and a weak jet is weak.
 *
 * Nothing outside this module counts in these: `stamp()` takes its bite in
 * passes and converts, `coverage()` counts cells and not their contents, and
 * `TUNING.depth` is still in passes. Deepest grime is tar at five, which is 320
 * - past a byte, hence the Uint16Array.
 */
export const SUBS = 64;

/** A field from a predicate over cell centres in 0..1 card space. `strength` is
 *  how many passes of the jet a cell takes; 1 is one and done. */
export function makeField(
  kind: MessKind, fill: (x: number, y: number) => boolean,
  grid = TUNING.grid, strength = 1,
): Field {
  const cells = new Uint16Array(grid * grid);
  const deep = Math.max(1, Math.min(65535, Math.round(strength * SUBS)));
  let total = 0;
  for (let iy = 0; iy < grid; iy++)
    for (let ix = 0; ix < grid; ix++) {
      if (!fill((ix + 0.5) / grid, (iy + 0.5) / grid)) continue;
      cells[iy * grid + ix] = deep;
      total++;
    }
  return { kind, cells, total, left: total };
}

/** An empty field of the same shape, for a card that was dealt no grime. */
export const emptyField = (kind: MessKind, grid = TUNING.grid): Field =>
  ({ kind, cells: new Uint16Array(grid * grid), total: 0, left: 0 });

/** Share of the mess still there, 1 at birth and 0 when spotless. A field that
 *  was never dealt anything reads 0 - nothing to clean is clean. */
export const coverage = (f: Field) => (f.total === 0 ? 0 : f.left / f.total);

/** Whether it counts gone. */
export const fieldClear = (f: Field) => coverage(f) <= 1 - TUNING.clearAt;

/**
 * Thin every cell whose centre falls inside the ellipse by `bite`. Radii are in
 * 0..1 card space, which is why they are separate: a world-unit circle is an
 * ellipse on a card that is not square.
 *
 * `skip` is the shield a piece of debris casts over the crust it is lying on.
 * Passed in rather than read from anything here, so this module still knows
 * nothing about what a leaf is - see canClean() in clean.ts.
 *
 * Returns the cells *finished*, which is what the sound and the particles read -
 * a pass that only thinned the crust has taken nothing yet.
 */
export function stamp(
  f: Field, x: number, y: number, rx: number, ry: number,
  bite = Infinity, skip: ((i: number) => boolean) | null = null,
): number {
  const grid = Math.round(Math.sqrt(f.cells.length));
  if (rx <= 0 || ry <= 0 || bite <= 0) return 0;
  // `bite` is in passes and may be a fraction of one; the grid counts sub-units.
  // At least one sub-unit, so a jet weak enough to round to nothing still wears
  // the crust down rather than silently doing nothing at all.
  const take = Math.max(1, Math.min(65535, Math.round(bite * SUBS)));
  const x0 = Math.max(0, Math.floor((x - rx) * grid));
  const x1 = Math.min(grid - 1, Math.ceil((x + rx) * grid));
  const y0 = Math.max(0, Math.floor((y - ry) * grid));
  const y1 = Math.min(grid - 1, Math.ceil((y + ry) * grid));
  let took = 0;
  for (let iy = y0; iy <= y1; iy++)
    for (let ix = x0; ix <= x1; ix++) {
      const i = iy * grid + ix;
      const had = f.cells[i]!;
      if (!had) continue;
      const dx = ((ix + 0.5) / grid - x) / rx;
      const dy = ((iy + 0.5) / grid - y) / ry;
      if (dx * dx + dy * dy > 1) continue;
      if (skip?.(i)) continue;
      const now = Math.max(0, had - take);
      f.cells[i] = now;
      if (now) continue;
      f.left--;
      took++;
    }
  return took;
}

// ---- the jet ------------------------------------------------------------

/**
 * The jet at a given hand speed, read off `TUNING.jet`.
 *
 * Linear between the rows and flat outside them, so a hand slower than the
 * first row is simply the first row - there is no extra reward for holding
 * perfectly still, which would be a thing to be good at rather than a thing to
 * notice.
 *
 * Both numbers are multipliers: `radius` on `reach.washer.radius`, `bite` on
 * the pass a stamp takes. Tank power multiplies the result at the call site, so
 * this stays a function of the hand alone.
 */
export function jetShape(speed: number): { radius: number, bite: number } {
  const rows = TUNING.jet;
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  if (!(speed > first.speed)) return { radius: first.radius, bite: first.bite };
  if (speed >= last.speed) return { radius: last.radius, bite: last.bite };
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]!;
    const b = rows[i]!;
    if (speed > b.speed) continue;
    const t = (speed - a.speed) / (b.speed - a.speed);
    return {
      radius: a.radius + (b.radius - a.radius) * t,
      bite: a.bite + (b.bite - a.bite) * t,
    };
  }
  return { radius: last.radius, bite: last.bite };
}

/**
 * How opaque the crust looks against how much of it is left, as an exponent.
 *
 * **Not linear.** A cell of tar takes five passes, and one pass of alpha per
 * pass of the grid walked what is seen down 0.8, 0.64, 0.48, 0.32, 0.16 - so
 * half of a tar cell's life was spent under two fifths opacity, where it is
 * barely visible and there is no telling what is still there to clean. Under
 * this the same five passes read 0.80, 0.74, 0.67, 0.58, 0.46, gone. It stays a
 * thing you can see until the pass that takes it, and then it goes quickly,
 * which is also the crisp reveal the edge wants.
 */
export const WEAR_CURVE = 0.35;

/**
 * The most of the visible crust one touch of the jet may take.
 *
 * **A stamp is not allowed to clear its own disc.** The share below is worked
 * out from the one cell under the nozzle, and then spread over an ellipse
 * covering forty of them - so a share of 1, which is what a finished centre
 * cell used to ask for, wiped the whole disc at full strength whatever the
 * cells around it still had left. What that draws is a hard-edged hole: full
 * crust to bare card across one pixel, with no falloff anywhere, which is
 * exactly what a fast sweep looked like.
 *
 * Capped, the radial falloff in `eraseAt` does its job and the gradient is the
 * overlap of a dozen partial bites rather than the profile of any one of them.
 * Nothing is left behind by it: a dozen touches at this share is a thousandth
 * of the alpha, and `dissolve()` takes the last of a field anyway.
 */
export const WEAR_MAX = 0.4;

/**
 * What the crust under one stamp is worth and what this bite will take from it,
 * both as fractions of a full-depth cell, averaged over the disc.
 *
 * **Measured over the whole ellipse and not over the one cell under the
 * nozzle.** The erase this feeds covers forty-odd cells, so reading one of them
 * and spreading its answer over all of them is only right when they agree. They
 * disagree most exactly where somebody is working: at the edge of a patch they
 * have half cleaned. Holding the jet on a cell that is already bare reported
 * "nothing left here", which is the `before <= 0` branch of wearShare() below
 * and its maximum erase - applied to the crust all round it that had barely
 * been touched. tick() stamps once a frame whether or not the hand is moving,
 * so a quarter of a second of holding still took that crust to four ten
 * thousandths of its alpha: invisible, and still counted dirty by the grid,
 * which is a card you cannot see and are not allowed to finish.
 *
 * Cells the shield covers are counted as present and as taking nothing, which
 * is what keeps the crust under a leaf from being washed away through it.
 *
 * Pure, and does not touch the grid - call it before `stamp()`.
 */
export function wearOf(
  f: Field, x: number, y: number, rx: number, ry: number,
  bite: number, span: number, skip: ((i: number) => boolean) | null = null,
): { before: number, taken: number } {
  const grid = Math.round(Math.sqrt(f.cells.length));
  if (rx <= 0 || ry <= 0 || span <= 0) return { before: 0, taken: 0 };
  const take = Math.max(0, bite) * SUBS;
  const x0 = Math.max(0, Math.floor((x - rx) * grid));
  const x1 = Math.min(grid - 1, Math.ceil((x + rx) * grid));
  const y0 = Math.max(0, Math.floor((y - ry) * grid));
  const y1 = Math.min(grid - 1, Math.ceil((y + ry) * grid));
  let had = 0;
  let got = 0;
  let n = 0;
  for (let iy = y0; iy <= y1; iy++)
    for (let ix = x0; ix <= x1; ix++) {
      const i = iy * grid + ix;
      const there = f.cells[i]!;
      // A cell that was never dealt anything is bare card, not thin crust, and
      // must not drag the average down - the erase is not aimed at it.
      if (!there) continue;
      const dx = ((ix + 0.5) / grid - x) / rx;
      const dy = ((iy + 0.5) / grid - y) / ry;
      if (dx * dx + dy * dy > 1) continue;
      had += there / span;
      if (!skip?.(i)) got += Math.min(there, take) / span;
      n++;
    }
  return n ? { before: had / n, taken: got / n } : { before: 0, taken: 0 };
}

/**
 * The share of the *visible* crust one stamp takes, given how much was there
 * (0..1) and how much of a pass is biting it (also 0..1). Both come from
 * `wearOf()` above, which measures them over the disc this erase will cover.
 *
 * In remaining-fraction rather than in passes: what is seen is meant to sit at
 * `left ^ WEAR_CURVE`, so a stamp erases whatever gets it from where it was to
 * where it should be. A disc with nothing left in it erases outright, which is
 * what makes the last of it leave rather than linger.
 */
export function wearShare(before: number, bite: number): number {
  if (before <= 0) return WEAR_MAX;
  const after = Math.max(0, before - bite);
  if (after <= 0) return WEAR_MAX;
  return Math.min(WEAR_MAX, 1 - Math.pow(after / before, WEAR_CURVE));
}

// ---- the tank -----------------------------------------------------------

/** How much water is left, 1 full and 0 empty. */
export type Tank = { level: number };

export const fullTank = (): Tank => ({ level: 1 });

/** The share of the tank the fade occupies: below it the jet is weakening. */
const fadeBand = () => TUNING.tank.fadeMs / (TUNING.tank.fullMs + TUNING.tank.fadeMs);

/**
 * How hard the jet is pushing, 0..1. Full while there is more than the fade
 * band left, then straight down to nothing - so the last two seconds are heard
 * and seen softening rather than stopping dead.
 */
export function tankPower(state: Tank): number {
  const band = fadeBand();
  if (state.level >= band) return 1;
  return Math.max(0, state.level / band);
}

/**
 * Move the tank on by `dtMs`.
 *
 * Refills from wherever it was rather than only from empty, so a short burst
 * costs a short rest - which is what keeps the rhythm a rhythm and not a queue.
 * Holding the trigger on an empty tank neither drains nor fills: let go.
 */
export function tankStep(state: Tank, dtMs: number, spraying: boolean): Tank {
  const { fullMs, fadeMs, refillMs } = TUNING.tank;
  const dt = Math.max(0, dtMs);
  if (spraying) return { level: Math.max(0, state.level - dt / (fullMs + fadeMs)) };
  return { level: Math.min(1, state.level + dt / refillMs) };
}

// ---- the glove ----------------------------------------------------------

/** How much of a handful one piece takes. Read through the wide type rather
 *  than off the table's literal one: `satisfies` keeps each row's own shape, so
 *  a grime has no `bulk` key at all and asking for it is an error rather than
 *  the undefined this is coalescing. */
const bulk = (kind: MessKind): number => {
  const def: MessDef = MESS[kind];
  return def.bulk ?? 1;
};

/** How much of a handful these pieces take up. */
export const bulkOf = (carried: readonly MessKind[]): number =>
  carried.reduce((sum, kind) => sum + bulk(kind), 0);

/** Whether one more piece would still fit in the hand. A glove that is full is
 *  not an error and says nothing: the piece simply stays where it is. */
export const handRoom = (carried: readonly MessKind[], piece: MessKind): boolean =>
  bulkOf(carried) + bulk(piece) <= TUNING.handful;

// ---- cobwebs ------------------------------------------------------------

export type Box = { id: string, x: number, y: number, w: number, h: number };

/**
 * A web spans **three** cards, not two, and is one thing: three strands round a
 * triangle, swept in one go, holding all three back until it is.
 *
 * It was a pair, and the pair's whole size was the gap between two cards - so a
 * board whose cards sat close, which is the board that gets webs at all, drew
 * scraps an inch across. The triangle is bounded by the cards' *spread* rather
 * than by any one gap between them, so it has room to be a web even when the
 * three are touching, and its long side crosses whatever happens to lie under
 * it rather than being refused for it.
 */
export type Web = { a: string, b: string, c: string };

/** The three cards a web names. */
export const webCards = (w: Web): [string, string, string] => [w.a, w.b, w.c];

/** Whether this web is one of the things holding that card back. */
export const webHolds = (w: Web, id: string) => w.a === id || w.b === id || w.c === id;

/** Shortest distance between two card edges; 0 if they touch or overlap. */
export function gapBetween(a: Box, b: Box): number {
  const dx = Math.max(0, Math.abs(a.x - b.x) - (a.w + b.w) / 2);
  const dy = Math.max(0, Math.abs(a.y - b.y) - (a.h + b.h) / 2);
  return Math.hypot(dx, dy);
}

/** Twice the area of the triangle on three cards' centres - the proxy for how
 *  big the drawn web will be. Centres and not edges: three cards that touch
 *  have no gap between them at all and still enclose a triangle a card wide. */
export function spreadOf(a: Box, b: Box, c: Box): number {
  return Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y));
}

type Pt = { x: number, y: number };

/** The triangle a web occupies, grown about its middle by `webRoom` - the
 *  strands sag below the edges and the spiral bellies outward, so a web needs
 *  more room than its bare corners. */
function roomOf(a: Box, b: Box, c: Box): Pt[] {
  const gx = (a.x + b.x + c.x) / 3;
  const gy = (a.y + b.y + c.y) / 3;
  const k = TUNING.webRoom;
  return [a, b, c].map(p => ({ x: gx + (p.x - gx) * k, y: gy + (p.y - gy) * k }));
}

/**
 * Whether two triangles share any ground, by separating axes: if there is a
 * line with all of one on one side and all of the other on the other, they are
 * apart. Six axes, one per edge, and the first one that separates them answers.
 *
 * Exact, unlike the bounding boxes this replaced - two webs at an angle to each
 * other have boxes that overlap and strands that do not, and refusing those
 * cost most of the webs on a board for nothing.
 */
export function trianglesOverlap(p: readonly Pt[], q: readonly Pt[]): boolean {
  for (const tri of [p, q])
    for (let i = 0; i < 3; i++) {
      const a = tri[i]!;
      const b = tri[(i + 1) % 3]!;
      // The outward normal of this edge.
      const nx = -(b.y - a.y);
      const ny = b.x - a.x;
      const span = (t: readonly Pt[]) => {
        let lo = Infinity;
        let hi = -Infinity;
        for (const v of t) {
          const d = v.x * nx + v.y * ny;
          lo = Math.min(lo, d);
          hi = Math.max(hi, d);
        }
        return { lo, hi };
      };
      const sp = span(p);
      const sq = span(q);
      if (sp.hi < sq.lo || sq.hi < sp.lo) return false;
    }
  return true;
}

/**
 * Webs on triples of cards that are genuinely close together. A board whose
 * cards are all spread out gets none, rather than a strand drooping into empty
 * space or stretched across half a screen - and on such a board the duster's
 * slot is not shown at all, which is better than a tool with nothing to do.
 *
 * **Biggest first, not closest first.** The pair version took the closest pair
 * it could find, which is precisely the pair with the least room between them:
 * it optimised for the scrap. Sorting on spread takes the trio that has the
 * most web in it, and `webArea` throws out the rest - three cards stacked on
 * one another, or three in a row, whose triangle is a sliver that draws as one
 * strand doubled over.
 *
 * Triples are ordered and each card carries at most `webPerCard` of them, which
 * keeps a tight cluster from turning into a net nobody wants to sweep.
 */
export function trioWebs(boxes: readonly Box[], rng: Rng = Math.random): Web[] {
  const near: { trio: Web, spread: number }[] = [];
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      if (gapBetween(a, b) > TUNING.webGap) continue;
      for (let k = j + 1; k < boxes.length; k++) {
        const c = boxes[k]!;
        // All three mutually close: a web is a thing that grew in one corner,
        // not a line of three cards passed along.
        if (gapBetween(a, c) > TUNING.webGap || gapBetween(b, c) > TUNING.webGap) continue;
        const spread = spreadOf(a, b, c);
        if (spread < TUNING.webArea) continue;
        near.push({ trio: { a: a.id, b: b.id, c: c.id }, spread });
      }
    }
  // The jitter keeps two equal spreads from always resolving the same way.
  near.sort((p, q) => (q.spread - p.spread) || (rng() - 0.5));
  const byId = new Map(boxes.map(b => [b.id, b]));
  const count = new Map<string, number>();
  const taken: Pt[][] = [];
  const out: Web[] = [];
  for (const { trio } of near) {
    const ids = webCards(trio);
    if (ids.some(id => (count.get(id) ?? 0) >= TUNING.webPerCard)) continue;
    // **Webs may not lie on top of one another.** Sharing no card is not
    // enough: two trios can interlock around each other and draw two hubs and
    // two spirals over the same ground, which reads as neither web. Biggest
    // first means the one that gives way is always the lesser of the two.
    const room = roomOf(byId.get(ids[0])!, byId.get(ids[1])!, byId.get(ids[2])!);
    if (taken.some(t => trianglesOverlap(room, t))) continue;
    for (const id of ids) count.set(id, (count.get(id) ?? 0) + 1);
    taken.push(room);
    out.push(trio);
  }
  return out;
}

// ---- dealing ------------------------------------------------------------

export type DebrisPlan = { kind: MessKind, x: number, y: number, rot: number, size: number };
export type CardPlan = { id: string, fields: MessKind[], debris: DebrisPlan[] };
export type BoardPlan = { cards: CardPlan[], webs: Web[] };

/**
 * Which cards get dirty, and with what. Random every time - the mess has no
 * relation to what a card holds, and a second run is a different board.
 *
 * **Grime and debris are dealt separately**, so a card can carry a handful of
 * leaves lying on a sheet of rust. That is the one bit of order in the game:
 * the jet will not clean under a leaf, so the leaf comes off first. A card that
 * rolls neither gets debris rather than nothing, because an untouched card in
 * the middle of a dirty board reads as a bug.
 *
 * Both tools are guaranteed something to do on any board with cards. The duster
 * is not: a web needs three cards close together and spread enough to be worth
 * drawing, and on a board that has no such trio its slot is simply absent.
 */
export function planBoard(boxes: readonly Box[], rng: Rng = Math.random): BoardPlan {
  const cards: CardPlan[] = boxes.map(box => deal(box.id, rng));
  guaranteeGrime(cards, rng);
  guaranteeDebris(cards, rng);
  return { cards, webs: trioWebs(boxes, rng) };
}

function deal(id: string, rng: Rng): CardPlan {
  const card: CardPlan = { id, fields: [], debris: [] };
  if (rng() < TUNING.grimeChance) card.fields.push(pick(rng, GRIMES));
  if (rng() < TUNING.debrisChance) card.debris = scatter(pick(rng, DEBRIS), rng);
  // Neither rolled: somebody has to sweep this card too.
  if (!card.fields.length && !card.debris.length) card.debris = scatter(pick(rng, DEBRIS), rng);
  return card;
}

function scatter(kind: MessKind, rng: Rng): DebrisPlan[] {
  // Gum is a single stuck thing, not a scatter - one peel, not nine. Paper,
  // caps and balls of dust come in ones and twos; only leaves and crumbs arrive
  // by the handful.
  const n = kind === 'gum' ? 1
    : kind === 'paper' || kind === 'cap' || kind === 'dust' ? randInt(rng, ...TUNING.fewPieces)
      : randInt(rng, ...TUNING.perPatch);
  const cx = rand(rng, 0.25, 0.75);
  const cy = rand(rng, 0.25, 0.75);
  const out: DebrisPlan[] = [];
  for (let i = 0; i < n; i++) out.push({
    kind,
    x: Math.min(0.94, Math.max(0.06, cx + rand(rng, -0.26, 0.26))),
    y: Math.min(0.94, Math.max(0.06, cy + rand(rng, -0.26, 0.26))),
    rot: rand(rng, 0, Math.PI * 2),
    size: rand(rng, 0.75, 1.35),
  });
  return out;
}

/** Add to the emptiest card rather than re-dealing the board: a card may carry
 *  both now, so a guarantee has nothing to overwrite. */
function guaranteeGrime(cards: CardPlan[], rng: Rng) {
  if (!cards.length || cards.some(c => c.fields.length)) return;
  pick(rng, cards).fields.push(pick(rng, GRIMES));
}

function guaranteeDebris(cards: CardPlan[], rng: Rng) {
  if (!cards.length || cards.some(c => c.debris.length)) return;
  // Not onto the card the grime guarantee has just claimed, where there is
  // anywhere else - the first card you touch should want one tool, not two.
  const spare = cards.filter(c => !c.fields.length);
  const card = pick(rng, spare.length ? spare : cards);
  card.debris = scatter(pick(rng, DEBRIS), rng);
}

// ---- counting -----------------------------------------------------------

/** The live state of one card, as the bar's counter sees it. A piece carries
 *  its kind because the badge has to ask which *tool* wants it; the counter
 *  itself still only ever reads the length. */
export type CardState = { id: string, fields: Field[], debris: readonly { kind: MessKind }[] };

/**
 * A card is clean when its own mess is gone *and* no web still touches it.
 * A web holds all three of its cards back, which is what makes the strands
 * between cards the last thing anybody sweeps - the right shape for an ending.
 */
export function cardClean(card: CardState, webs: readonly Web[]): boolean {
  if (card.debris.length) return false;
  if (!card.fields.every(fieldClear)) return false;
  return !webs.some(w => webHolds(w, card.id));
}

/**
 * Cards clean, out of cards dealt, and whether the board is finished.
 *
 * Two things outside the cards can hold the board back, and both are things
 * somebody is still holding or has put down: debris tipped out onto the bare
 * board (`loose`), and a glove that has not been emptied (`carrying`). A board
 * is not spotless while the mess is in your hand.
 */
export function tally(
  cards: readonly CardState[], webs: readonly Web[],
  loose = 0, carrying = false,
) {
  let clean = 0;
  for (const c of cards) if (cardClean(c, webs)) clean++;
  return {
    clean,
    total: cards.length,
    done: clean === cards.length && loose === 0 && !carrying,
  };
}

// ---- what the tool in hand still has to do here -------------------------

/** What one card was dealt that a tool counts against. A field carries its own
 *  denominator; pieces and strands do not, so the mode remembers them. */
export type Dealt = { debris: number, webs: number };

/** Work outstanding and work dealt, in whatever unit the tool measures in. */
export type ToolWork = { left: number, total: number };

/** Which tools have any work at all in each family, read off the table once
 *  rather than written out again here. A denominator is only added for a tool
 *  that could have been dealt something in that family - otherwise picking up
 *  the duster would put every card's debris count in the duster's total. */
const FAMILY_TOOLS: Record<MessFamily, ToolId[]> = { field: [], debris: [], web: [] };
// SAFETY: MESS is `satisfies Record<MessKind, MessDef>`, so its keys are
// exactly MessKind and nothing can be in there that is not one.
for (const kind of Object.keys(MESS) as MessKind[]) {
  const { family, tool } = MESS[kind];
  if (!FAMILY_TOOLS[family].includes(tool)) FAMILY_TOOLS[family].push(tool);
}

/**
 * What `tool` still has to do on this card, and how much there ever was.
 *
 * The units differ per tool - sub-units of a pass for the washer, pieces for
 * the glove, strands for the duster - and that is fine, because one call is
 * about one tool and the two numbers are only ever divided by each other.
 *
 * Routed through `MESS[kind].tool` rather than through the family, so a new
 * kind is an entry in that table and nothing here. A web belongs to both the
 * cards it names: clearing it answers for both, which is the shape that makes
 * the strands between cards the last thing anybody sweeps.
 */
export function toolWork(
  card: CardState, webs: readonly Web[], tool: ToolId, dealt: Dealt,
): ToolWork {
  let left = 0;
  let total = 0;
  for (const f of card.fields) {
    if (MESS[f.kind].tool !== tool) continue;
    left += f.left;
    total += f.total;
  }
  if (FAMILY_TOOLS.debris.includes(tool)) {
    for (const b of card.debris) if (MESS[b.kind].tool === tool) left++;
    total += dealt.debris;
  }
  if (FAMILY_TOOLS.web.includes(tool)) {
    for (const w of webs) if (webHolds(w, card.id)) left++;
    total += dealt.webs;
  }
  return { left, total };
}

/** Whether to show the tool a bang rather than a check. */
export const toolWanted = (w: ToolWork) => w.left > 0;

/** How far round the badge's arc has come. One when there was never anything
 *  to do, which is the whole of the check-by-default rule: a tool with no work
 *  on this card is a tool that is finished with it. */
export const toolShare = (w: ToolWork) => (w.total ? 1 - Math.min(1, w.left / w.total) : 1);
