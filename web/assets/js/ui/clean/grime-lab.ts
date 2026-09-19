// Grime bench (lab-grime.html). Every caked grime the cleaning mode deals, on a
// row of cards per kind, with LOOK (art.ts) on sliders and a printout of what
// moved. Paints through the real paintField(), so what is tuned here is what the
// game draws. Off the design system - own flat colours, no tokens.css. Bundled
// separately via `npm run dev:grime`.

import { LOOK, GRIME_KINDS, paintField, eraseAt, type Grime } from './art.ts';
import { GRIMES } from './mess.ts';

type Range = readonly [min: number, max: number, step: number];

/** Slider ranges by knob name. A knob with no entry here gets no slider, so a
 *  number added to LOOK shows up as missing rather than as a guess. */
const RANGE: Record<string, Range> = {
  azimuth: [-180, 180, 1], elevation: [5, 90, 0.5], ambient: [0, 1, 0.01],
  scale: [0.25, 4, 0.05], relief: [0, 0.06, 0.001], gloss: [0, 1.5, 0.05], shine: [1, 120, 1],
  tone: [0.4, 1.6, 0.01], sat: [0, 2, 0.01], warmth: [-2, 2, 0.05],
  flakes: [3, 30, 0.5], age: [0, 0.8, 0.01], pits: [0, 1, 0.01],
  wrinkles: [0, 1, 0.01], blisters: [0, 1, 0.01],
  blots: [1, 10, 1], size: [0.05, 0.6, 0.01], tide: [0, 1, 0.01], fray: [0, 0.3, 0.005],
  wipe: [0, 1, 0.01], grain: [10, 160, 1],
  cover: [0.2, 1, 0.01], bands: [0, 8, 1], poster: [0, 8, 1],
  patch: [0, 1, 0.01], edge: [0, 1, 0.01],
  rings: [1, 14, 0.5], crust: [0, 1, 0.01], film: [0, 1, 0.01], stain: [0, 1, 0.01], spots: [0, 1, 0.01],
  scaly: [0, 1, 0.01], runs: [0, 1.5, 0.01], spread: [0.3, 1.3, 0.01], drift: [0, 1.5, 0.01], scour: [0, 1.5, 0.01], ripples: [0, 40, 0.5], grit: [0, 1, 0.01], thin: [0, 1, 0.01],
  body: [0, 1, 0.01], drops: [0, 12, 1], rim: [0, 1, 0.01],
  streaks: [1, 12, 0.5], fine: [0, 1, 0.01],
};

/** LOOK.vary's own ranges: its names collide with the grimes' and mean spreads. */
const VARY_RANGE: Record<string, Range> = {
  scale: [0, 2, 0.05], tone: [0, 0.6, 0.01], warmth: [0, 2, 0.05], cover: [0, 0.6, 0.01],
  patch: [0, 0.6, 0.01],
};

/** Knobs every grime has, set on all six at once from the "all" section. */
const ALL: Record<string, Range> = {
  cover: [0.2, 1, 0.01], patch: [0, 1, 0.01], edge: [0, 1, 0.01],
  bands: [0, 8, 1], poster: [0, 8, 1], sat: [0, 2, 0.01], tone: [0.4, 1.6, 0.01],
};

const STORE = 'mbrd.lab.grime';

/** The defaults, taken before anything is restored over them. */
const DEFAULTS: Record<string, Record<string, number>> = JSON.parse(JSON.stringify(LOOK));
const DEFAULT_DEAL = [...GRIMES];

type Preset = Record<string, Record<string, number>>;

/** The spread and the mix the three redesigns share: every card its own, and
 *  a picture dealt a mix rather than mostly one grime. */
const VARIED = { scale: 0.7, tone: 0.12, warmth: 0.3, cover: 0.1, patch: 0.25 };
const DEAL_REDESIGN = ['lime', 'lime', 'dirt', 'dirt', 'rust', 'rust', 'tar', 'film'] as const;

/**
 * The looks to start from, as changes over the defaults. The three redesigns
 * were worked out on tools/grime-shots.mjs's contact sheets. `varied` won and
 * is the defaults now, so `today` is it; `illustrated` flattens light and
 * colour into bands, `heavy` deepens the relief under a lower light.
 */
const PRESETS: Record<string, { look: Preset, deal: readonly string[] }> = {
  today: { look: {}, deal: DEFAULT_DEAL },
  illustrated: {
    look: {
      light: { ambient: 0.55 },
      vary: { ...VARIED, scale: 0.6, cover: 0.08, patch: 0.2 },
      lime: { patch: 0.2, edge: 0.3, bands: 3, poster: 5, relief: 0.008, sat: 1.25, cover: 0.9 },
      dirt: { bands: 3, poster: 5, relief: 0.01, sat: 1.25, cover: 0.92 },
      rust: { patch: 0.2, edge: 0.2, bands: 3, poster: 5, relief: 0.014, sat: 1.2, scale: 1.5 },
      tar: { bands: 3, poster: 5, relief: 0.02, cover: 0.92, scale: 1.5, gloss: 1, shine: 30 },
      coffee: { body: 0.35, tide: 0.95, bands: 3, poster: 5, sat: 1.25, cover: 0.92, drops: 3 },
      ink: { fray: 0.1, bands: 3, poster: 5, cover: 0.95, drops: 6, rim: 0.6 },
      film: { fine: 0.8, streaks: 4, edge: 0.3, patch: 0.3, cover: 0.8, bands: 3, poster: 5 },
    },
    deal: DEAL_REDESIGN,
  },
  heavy: {
    look: {
      light: { ambient: 0.16, elevation: 32 },
      vary: { ...VARIED, cover: 0.08 },
      lime: { patch: 0.35, edge: 0.5, relief: 0.024, cover: 0.9, crust: 0.6 },
      dirt: { relief: 0.026, cover: 0.93, drift: 0.9, grit: 0.6 },
      rust: { patch: 0.3, edge: 0.4, pits: 0.18, scaly: 0.85, spread: 0.82, relief: 0.04, sat: 0.9 },
      tar: { patch: 0.15, relief: 0.038, cover: 0.92 },
      coffee: { body: 0.4, tide: 0.9, relief: 0.008, drops: 3 },
      ink: { fray: 0.15, relief: 0.011, drops: 6, rim: 0.6 },
      film: { fine: 0.7, streaks: 4, edge: 0.45, patch: 0.35, cover: 0.8, relief: 0.009 },
    },
    deal: DEAL_REDESIGN,
  },
};

/** LOOK viewed as the plain table of tables it is, for the generic walks. */
const table = (): Record<string, Record<string, number>> => LOOK;

type Card = {
  kind: Grime, seed: number, w: number, h: number, face: number,
  crust: HTMLCanvasElement, washed: boolean,
  /** On the dealt row, which is shown whatever the kind filter says. */
  dealt: boolean,
  /** The preset it is painted under, on the compare view; null is the
   *  sliders' own LOOK. */
  look: string | null,
};

const cards: Card[] = [];
const queue = new Set<Card>();
const view: {
  mode: 'compare' | 'tune', perRow: number, shape: string, rich: boolean, show: Set<string>,
} = { mode: 'compare', perRow: 6, shape: 'mixed', rich: true, show: new Set<string>(GRIME_KINDS) };

const LOOK_BLURB: Record<string, string> = {
  today: 'What the game draws now - the varied look: natural materials, every card its own.',
  illustrated: 'Flat painted patches and stepped shading, like a poster.',
  heavy: 'Deep relief under a low light: gritty rust, wet glossy tar.',
};

/** How many cards the dealt row holds: about a board's worth of pictures. */
const DEALT = 12;
let seedBase = 1;
let frame = 0;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** A seeded 0..1, so a card's face and crust come back the same on a rebuild. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9 >>> 0;
    s ^= s >>> 13;
    return (s >>> 0) / 4294967296;
  };
}

const SHAPES: Record<string, readonly [number, number][]> = {
  square: [[190, 190]],
  landscape: [[240, 160]],
  portrait: [[160, 230]],
  mixed: [[240, 160], [190, 190], [160, 230], [260, 150], [200, 250]],
};

// ---- the cards under the crust -----------------------------------------------

/** Something for the crust to be over: a photograph, a note, a blank card, a
 *  dark picture. A crust is judged against what it hides, and against paper
 *  alone every grime reads darker than it will on a board of pictures. */
function paintFace(ctx: CanvasRenderingContext2D, w: number, h: number, face: number, seed: number) {
  const r = rng(seed * 7 + 3);
  if (face === 0) {
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#9cc4dc');
    sky.addColorStop(1, '#f1dcb8');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#e9b04f';
    ctx.beginPath();
    ctx.arc(w * (0.2 + r() * 0.6), h * 0.36, h * 0.1, 0, Math.PI * 2);
    ctx.fill();
    for (const [c, y0] of [['#6f8f5a', 0.62], ['#4d6a45', 0.74]] as const) {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x <= w; x += 8) ctx.lineTo(x, h * y0 + Math.sin(x / w * 6 + r() * 0.4 + y0 * 9) * h * 0.06);
      ctx.lineTo(w, h);
      ctx.fill();
    }
  } else if (face === 1) {
    ctx.fillStyle = '#fbf1b8';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#3b3326';
    ctx.font = '600 15px Georgia, serif';
    ctx.fillText('Things to fix', 14, 26);
    ctx.fillStyle = '#6d6250';
    for (let y = 46; y < h - 10; y += 16) ctx.fillRect(14, y, (w - 28) * (0.5 + r() * 0.5), 2);
  } else if (face === 2) {
    ctx.fillStyle = '#fbfaf6';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#b9b2a4';
    ctx.font = '12px ui-monospace, monospace';
    ctx.fillText('plain card', 12, 22);
  } else {
    const g = ctx.createRadialGradient(w * 0.5, h * 0.45, 4, w * 0.5, h * 0.5, Math.max(w, h) * 0.7);
    g.addColorStop(0, '#c2573a');
    g.addColorStop(0.5, '#4a2c3a');
    g.addColorStop(1, '#161219');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
}

// ---- painting --------------------------------------------------------------

/** Queue a repaint. Painted a few at a time per frame so a slider stays live
 *  even with forty cards on the bench - the game paints one card a frame. */
function repaint(which: (c: Card) => boolean) {
  for (const c of cards) if (which(c)) queue.add(c);
  if (!frame) frame = requestAnimationFrame(drain);
}

function drain() {
  frame = 0;
  const until = performance.now() + 14;
  for (const c of queue) {
    queue.delete(c);
    if (!c.dealt && !c.look && !view.show.has(c.kind)) continue;
    const ctx = c.crust.getContext('2d');
    if (!ctx) continue;
    ctx.clearRect(0, 0, c.w, c.h);
    under(c.look, () => paintField(ctx, { kind: c.kind, seed: c.seed }, c.w, c.h, view.rich));
    c.washed = false;
    if (performance.now() > until) break;
  }
  if (queue.size) frame = requestAnimationFrame(drain);
}

/** Run `fn` with LOOK set to a preset, then put the sliders' values back.
 *  LOOK is the one table the painter reads, so four looks on one page means
 *  lending it out a card at a time - painting is synchronous, so nothing else
 *  sees the loan. */
function under(name: string | null, fn: () => void) {
  const preset = name ? PRESETS[name] : null;
  if (!preset) { fn(); return; }
  const look = table();
  const kept: Record<string, Record<string, number>> = JSON.parse(JSON.stringify(look));
  for (const [section, knobs] of Object.entries(DEFAULTS))
    for (const [key, was] of Object.entries(knobs)) look[section]![key] = preset.look[section]?.[key] ?? was;
  try {
    fn();
  } finally {
    for (const [section, knobs] of Object.entries(kept))
      for (const [key, value] of Object.entries(knobs)) look[section]![key] = value;
  }
}

/** Scrub a card with the pointer: the jet's own bite, so the reveal can be
 *  judged too - a crust that looks right and washes off wrong is not right. */
function wash(card: Card, e: PointerEvent) {
  const box = card.crust.getBoundingClientRect();
  const ctx = card.crust.getContext('2d');
  if (!ctx) return;
  const x = (e.clientX - box.left) * (card.w / box.width);
  const y = (e.clientY - box.top) * (card.h / box.height);
  eraseAt(ctx, x, y, 22, 22, 0.35, Math.random);
  card.washed = true;
}

// ---- the board ---------------------------------------------------------------

function makeCard(
  kind: Grime, seed: number, w: number, h: number, face: number, dealt: boolean, look: string | null = null,
) {
  const card: Card = { kind, seed, w, h, face, crust: el('canvas', 'crust'), washed: false, dealt, look };
  const host = el('div', 'card');
  host.dataset.seed = String(seed);
  host.title = `${kind}, seed ${seed} - drag to wash`;
  const canvas = el('canvas', 'face');
  canvas.width = card.crust.width = w;
  canvas.height = card.crust.height = h;
  host.style.width = w + 'px';
  host.style.height = h + 'px';
  const fctx = canvas.getContext('2d');
  if (fctx) paintFace(fctx, w, h, face, seed);
  card.crust.addEventListener('pointerdown', e => {
    card.crust.setPointerCapture(e.pointerId);
    wash(card, e);
  });
  card.crust.addEventListener('pointermove', e => {
    if (card.crust.hasPointerCapture(e.pointerId)) wash(card, e);
  });
  host.append(canvas, card.crust);
  if (dealt || look) host.append(el('span', 'tag', kind));
  cards.push(card);
  return host;
}

/** The row a picture board would actually be dealt: its kinds drawn from
 *  GRIMES the way planBoard() draws them, so the mix can be judged as a mix. */
function buildDealt(board: HTMLElement) {
  const row = el('section', 'row dealt');
  const counts = GRIME_KINDS.map(k => `${k} ${GRIMES.filter(g => g === k).length}`)
    .filter(s => !s.endsWith(' 0')).join(' / ');
  row.append(el('h3', '', `a board of pictures, as dealt - ${counts}`));
  const strip = el('div', 'strip');
  const r = rng(seedBase * 31 + 5);
  const shapes = SHAPES.mixed!;
  for (let i = 0; i < DEALT; i++) {
    const kind = GRIMES[Math.floor(r() * GRIMES.length)];
    const grime = GRIME_KINDS.find(g => g === kind);
    if (!grime) continue;
    const [w, h] = shapes[i % shapes.length]!;
    const seed = (seedBase * 104723 + i * 2654435761) >>> 0;
    // Pictures, since pictures are what GRIMES is dealt to: the photo and the
    // dark one, taking turns.
    strip.append(makeCard(grime, seed, Math.round(w * 0.8), Math.round(h * 0.8), i % 2 ? 3 : 0, true));
  }
  row.append(strip);
  board.append(row);
}

/** How many pictures each column of the compare view deals. */
const COMPARE_DEALT = 6;

/**
 * Every look side by side, one column each, on the same seeds - so a column
 * differs from its neighbour in the look and nothing else. Each deals its own
 * board of pictures from its own mix, then shows one card of every grime.
 */
function buildCompare(board: HTMLElement) {
  const grid = el('div', 'compare');
  const shapes = SHAPES.mixed!;
  const small = (n: number) => Math.round(n * 0.62);
  for (const [name, preset] of Object.entries(PRESETS)) {
    const col = el('section', 'look');
    const head = el('div', 'look-head');
    const tune = el('button', '', 'tune this');
    tune.type = 'button';
    tune.title = 'Open this look on the sliders';
    tune.addEventListener('click', () => { setMode('tune'); applyPreset(name); });
    head.append(el('h3', '', name), tune);
    col.append(head, el('p', 'blurb', LOOK_BLURB[name] ?? ''));

    col.append(el('h4', '', 'a board of pictures'));
    const dealt = el('div', 'strip');
    const r = rng(seedBase * 31 + 5);
    for (let i = 0; i < COMPARE_DEALT; i++) {
      const pick = preset.deal[Math.floor(r() * preset.deal.length)];
      const grime = GRIME_KINDS.find(g => g === pick);
      if (!grime) continue;
      const [w, h] = shapes[i % shapes.length]!;
      const seed = (seedBase * 104723 + i * 2654435761) >>> 0;
      dealt.append(makeCard(grime, seed, small(w), small(h), i % 2 ? 3 : 0, false, name));
    }
    col.append(dealt, el('h4', '', 'every grime'));
    const every = el('div', 'strip');
    GRIME_KINDS.forEach((kind, k) => {
      const [w, h] = shapes[k % shapes.length]!;
      const seed = (seedBase * 7919 + k * 104729) >>> 0;
      every.append(makeCard(kind, seed, small(w), small(h), k % 4, false, name));
    });
    col.append(every);
    grid.append(col);
  }
  board.append(grid);
}

/** Compare the looks, or tune one. The aside's tuning half is only there for
 *  the second. */
function setMode(mode: 'compare' | 'tune') {
  view.mode = mode;
  document.body.classList.toggle('is-compare', mode === 'compare');
  for (const b of document.querySelectorAll<HTMLButtonElement>('#modes button')) {
    toggle(b, b.dataset.mode === mode);
  }
  buildBoard();
}

function buildBoard() {
  const board = document.getElementById('board');
  if (!board) return;
  board.replaceChildren();
  cards.length = 0;
  queue.clear();
  if (view.mode === 'compare') {
    buildCompare(board);
    repaint(() => true);
    return;
  }
  buildDealt(board);
  const shapes = SHAPES[view.shape] ?? SHAPES.mixed!;
  for (const kind of GRIME_KINDS) {
    const row = el('section', 'row');
    row.dataset.kind = kind;
    row.hidden = !view.show.has(kind);
    row.append(el('h3', '', kind));
    const strip = el('div', 'strip');
    for (let i = 0; i < view.perRow; i++) {
      const [w, h] = shapes[i % shapes.length]!;
      const seed = (seedBase * 7919 + GRIME_KINDS.indexOf(kind) * 104729 + i * 15485863) >>> 0;
      strip.append(makeCard(kind, seed, w, h, i % 4, false));
    }
    row.append(strip);
    board.append(row);
  }
  repaint(() => true);
}

// ---- the sliders -----------------------------------------------------------

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({ look: LOOK, deal: GRIMES }));
  } catch { /* private mode */ }
}

function restore() {
  let saved: unknown;
  try { saved = JSON.parse(localStorage.getItem(STORE) ?? 'null'); } catch { return; }
  if (!saved || typeof saved !== 'object') return;
  const look = 'look' in saved ? saved.look : saved;
  if (look && typeof look === 'object') {
    const into = table();
    for (const [section, knobs] of Object.entries(look)) {
      const knobsInto = into[section];
      if (!knobsInto || !knobs || typeof knobs !== 'object') continue;
      for (const [key, value] of Object.entries(knobs)) {
        if (key in knobsInto && typeof value === 'number' && Number.isFinite(value)) knobsInto[key] = value;
      }
    }
  }
  if ('deal' in saved && Array.isArray(saved.deal)) {
    const deal = saved.deal.filter(k => GRIME_KINDS.some(g => g === k));
    if (deal.length) GRIMES.splice(0, GRIMES.length, ...deal);
  }
}

const decimals = (step: number) => (String(step).split('.')[1] ?? '').length;

type Knob = {
  name: string, range: Range, get: () => number, set: (v: number) => void, was: number,
  /** Which cards to repaint when it moves; null rebuilds the board. */
  repaints: ((c: Card) => boolean) | null,
};

function field(knob: Knob) {
  const [min, max, step] = knob.range;
  const row = el('label', 'field');
  const input = el('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(knob.get());
  const out = el('span', 'value');
  const paint = () => {
    const v = knob.get();
    out.textContent = v.toFixed(decimals(step));
    row.classList.toggle('is-moved', v !== knob.was);
  };
  input.addEventListener('input', () => {
    knob.set(Number(input.value));
    paint();
    save();
    printOut();
    if (knob.repaints) repaint(knob.repaints);
    else buildBoard();
  });
  // A double-click on the name puts the one knob back.
  row.addEventListener('dblclick', () => {
    input.value = String(knob.was);
    input.dispatchEvent(new Event('input'));
  });
  paint();
  row.append(el('span', 'name', knob.name), input, out);
  return row;
}

/** A knob of LOOK's own. A grime's repaints its row; the light and the
 *  spread repaint everything. */
function lookKnob(section: string, key: string, range: Range): Knob {
  const look = table();
  return {
    name: key, range, was: DEFAULTS[section]![key]!,
    get: () => look[section]![key]!,
    set: v => { look[section]![key] = v; },
    repaints: c => section === 'light' || section === 'vary' || c.kind === section,
  };
}

/** One knob across every grime: reads limescale's, writes everybody's. */
function allKnob(key: string, range: Range): Knob {
  const look = table();
  return {
    name: key, range, was: DEFAULTS.lime![key]!,
    get: () => look.lime![key]!,
    set: v => { for (const g of GRIME_KINDS) look[g]![key] = v; },
    repaints: () => true,
  };
}

/** How many of each grime are in GRIMES, the list a picture is dealt from. */
function dealKnob(kind: Grime): Knob {
  const count = () => GRIMES.filter(g => g === kind).length;
  return {
    name: kind, range: [0, 6, 1], was: DEFAULT_DEAL.filter(g => g === kind).length,
    get: count,
    set: v => {
      const rest = GRIMES.filter(g => g !== kind);
      // Never empty: planBoard() picks from it, and an empty list deals nothing.
      if (!rest.length && v < 1) v = 1;
      GRIMES.splice(0, GRIMES.length, ...rest, ...Array.from({ length: v }, () => kind));
      const at = (k: string) => GRIME_KINDS.findIndex(g => g === k);
      GRIMES.sort((a, b) => at(a) - at(b));
    },
    repaints: null,
  };
}

const BLURB: Record<string, string> = {
  all: 'Sets the knob on every grime at once. The per-grime sliders below follow.',
  deal: 'What a picture card is dealt, as weights. The top row of the bench is dealt from this.',
  light: 'One light for every grime. Azimuth: 0 is from the right, -90 from the top.',
  vary: 'How far each card strays from the others of its kind. 0 makes every card of a kind the same.',
  lime: 'Hard-water limescale: tide marks, dried drop spots, chalky crust where it pooled, a thin milky film between.',
  dirt: 'Soil the wind laid over the card: drifts, streaks it scoured thin, ripples across the wind, grit. Each card has its own wind.',
  rust: 'Always opaque (cover does nothing here; thin places turn orange instead). Spread = how far across the card it has got from the side or corner it started at (the bare part counts as clean). Scaly = how much lifts in curling flakes, runs = streaks down. Age: lower is more orange, higher is more old brown.',
  tar: 'A wet skin. Gloss and shine are most of it.',
  coffee: 'A spill of rings. Tide = how much of the darkness is the ring at the edge.',
  ink: 'Blots with frayed edges.',
  film: 'A dust film with finger wipes through it.',
};

function buildSliders() {
  const host = document.getElementById('knobs');
  if (!host) return;
  host.replaceChildren();
  const look = table();
  const section = (name: string, open: boolean, knobs: Knob[]) => {
    const box = el('details', 'section');
    box.open = open;
    box.append(el('summary', '', name), el('p', 'blurb', BLURB[name] ?? ''));
    for (const knob of knobs) box.append(field(knob));
    host.append(box);
  };
  section('all', true, Object.entries(ALL).map(([key, range]) => allKnob(key, range)));
  section('deal', true, GRIME_KINDS.map(dealKnob));
  for (const name of Object.keys(look)) {
    const knobs: Knob[] = [];
    for (const key of Object.keys(look[name]!)) {
      const range = name === 'vary' ? VARY_RANGE[key] : RANGE[key];
      if (range) knobs.push(lookKnob(name, key, range));
    }
    section(name, name === 'vary', knobs);
  }
}

/** What moved, as lines to paste back into LOOK in art.ts and GRIMES in
 *  mess.ts. */
function printOut() {
  const out = document.getElementById('out');
  if (!out) return;
  const look = table();
  const lines: string[] = [];
  for (const [section, knobs] of Object.entries(look)) {
    for (const [key, value] of Object.entries(knobs)) {
      const was = DEFAULTS[section]![key]!;
      if (value !== was) lines.push(`LOOK.${section}.${key}: ${was} -> ${value}`);
    }
  }
  if (GRIMES.join() !== DEFAULT_DEAL.join()) {
    lines.push(`GRIMES: [${DEFAULT_DEAL.join(', ')}] -> [${GRIMES.join(', ')}]`);
  }
  out.textContent = lines.length ? lines.join('\n') : 'nothing moved yet';
}

/** Put every knob where a preset says, from the defaults rather than from
 *  wherever the sliders are, so pressing one twice is the same look. */
function applyPreset(name: string) {
  const preset = PRESETS[name];
  if (!preset) return;
  const look = table();
  for (const [section, knobs] of Object.entries(DEFAULTS))
    for (const [key, was] of Object.entries(knobs)) look[section]![key] = preset.look[section]?.[key] ?? was;
  const deal = preset.deal.flatMap(k => GRIME_KINDS.filter(g => g === k));
  GRIMES.splice(0, GRIMES.length, ...deal);
  save();
  buildSliders();
  printOut();
  buildBoard();
}

// ---- the controls ----------------------------------------------------------

function toggle(button: HTMLButtonElement, on: boolean) {
  button.setAttribute('aria-pressed', String(on));
}

function buildControls() {
  const kinds = document.getElementById('kinds');
  if (kinds) {
    kinds.replaceChildren();
    for (const kind of GRIME_KINDS) {
      const b = el('button', '', kind);
      b.type = 'button';
      toggle(b, view.show.has(kind));
      b.addEventListener('click', e => {
        // Shift shows only this one.
        if (e.shiftKey) view.show = new Set([kind]);
        else if (view.show.has(kind)) view.show.delete(kind);
        else view.show.add(kind);
        for (const other of kinds.querySelectorAll('button')) {
          toggle(other, view.show.has(other.textContent ?? ''));
        }
        for (const row of document.querySelectorAll<HTMLElement>('#board .row')) {
          row.hidden = !view.show.has(row.dataset.kind ?? '');
        }
        repaint(c => c.kind === kind);
      });
      kinds.append(b);
    }
  }

  const on = (id: string, type: string, fn: (e: Event) => void) =>
    document.getElementById(id)?.addEventListener(type, fn);

  const presets = document.getElementById('presets');
  if (presets) {
    presets.replaceChildren();
    for (const name of Object.keys(PRESETS)) {
      const b = el('button', '', name);
      b.type = 'button';
      b.addEventListener('click', () => applyPreset(name));
      presets.append(b);
    }
  }

  for (const b of document.querySelectorAll<HTMLButtonElement>('#modes button')) {
    b.addEventListener('click', () => setMode(b.dataset.mode === 'tune' ? 'tune' : 'compare'));
  }

  on('reseed', 'click', () => { seedBase++; buildBoard(); });
  on('reseed-compare', 'click', () => { seedBase++; buildBoard(); });
  on('unwash-compare', 'click', () => repaint(c => c.washed));
  on('unwash', 'click', () => repaint(c => c.washed));
  on('reset', 'click', () => applyPreset('today'));
  on('copy', 'click', () => {
    const text = document.getElementById('out')?.textContent ?? '';
    navigator.clipboard?.writeText(text).catch(() => {});
  });
  on('per-row', 'input', e => {
    if (e.target instanceof HTMLInputElement) view.perRow = Number(e.target.value);
    buildBoard();
  });
  on('shape', 'change', e => {
    if (e.target instanceof HTMLSelectElement) view.shape = e.target.value;
    buildBoard();
  });
  on('rich', 'change', e => {
    if (e.target instanceof HTMLInputElement) view.rich = e.target.checked;
    repaint(() => true);
  });
}

export function initGrimeLab() {
  restore();
  buildControls();
  buildSliders();
  printOut();
  setMode('compare');
}
